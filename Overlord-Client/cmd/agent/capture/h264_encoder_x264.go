//go:build cgo && !windows

package capture

import (
	"bytes"
	"fmt"
	"image"
	"sync"
	"sync/atomic"

	x264 "github.com/gen2brain/x264-go"
)

var (
	h264Mu                 sync.Mutex
	h264Enc                *x264.Encoder
	h264Buf                bytes.Buffer
	h264Width              int
	h264Height             int
	h264FPS                int
	h264LastErr            error
	h264Scratch            []byte
	desktopH264TargetFPS   atomic.Int64
	backstageH264TargetFPS atomic.Int64
	webcamH264TargetFPS    atomic.Int64
)

func encodeH264Frame(img *image.RGBA) ([]byte, error) {
	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()

	h264Mu.Lock()
	defer h264Mu.Unlock()

	if err := ensureH264EncoderLocked(width, height); err != nil {
		h264LastErr = err
		return nil, err
	}

	h264Buf.Reset()
	if err := h264Enc.Encode(img); err != nil {
		h264LastErr = err
		return nil, err
	}
	h264LastErr = nil

	n := h264Buf.Len()
	if n == 0 {
		return nil, nil
	}
	if cap(h264Scratch) < n {
		h264Scratch = make([]byte, n, n+(n/4))
	} else {
		h264Scratch = h264Scratch[:n]
	}
	copy(h264Scratch, h264Buf.Bytes())
	return h264Scratch, nil
}

func h264Available() bool {
	return true
}

func h264AvailabilityDetail() string {
	h264Mu.Lock()
	defer h264Mu.Unlock()
	if h264LastErr != nil {
		return fmt.Sprintf("x264 runtime error: %v", h264LastErr)
	}
	return "cgo build with x264-go"
}

func SetDesktopH264TargetFPS(fps int) {
	setH264TargetFPS(&desktopH264TargetFPS, fps)
}

func SetBackstageH264TargetFPS(fps int) {
	setH264TargetFPS(&backstageH264TargetFPS, fps)
}

func SetWebcamH264TargetFPS(fps int) {
	setH264TargetFPS(&webcamH264TargetFPS, fps)
}

func setH264TargetFPS(target *atomic.Int64, fps int) {
	if fps < 1 {
		fps = 1
	}
	target.Store(int64(fps))
}

func activeH264FPS() int {
	return activeH264FPSValue(&desktopH264TargetFPS, 60)
}

func activeH264FPSValue(target *atomic.Int64, fallback int) int {
	if v := int(target.Load()); v > 0 {
		return v
	}
	return fallback
}

func ensureH264EncoderLocked(width, height int) error {
	fps := activeH264FPS()
	if h264Enc != nil && h264Width == width && h264Height == height && h264FPS == fps {
		return nil
	}

	closeH264EncoderLocked()

	opts := &x264.Options{
		Width:        width,
		Height:       height,
		FrameRate:    fps,
		Tune:         "zerolatency",
		Preset:       "veryfast",
		Profile:      "main",
		RateControl:  "crf",
		RateConstant: targetH264CRF(width, height, fps),
		LogLevel:     x264.LogError,
	}

	enc, err := x264.NewEncoder(&h264Buf, opts)
	if err != nil {
		return err
	}

	h264Enc = enc
	h264Width = width
	h264Height = height
	h264FPS = fps
	return nil
}

func resetH264Encoder() {
	h264Mu.Lock()
	defer h264Mu.Unlock()
	closeH264EncoderLocked()
}

func RequestDesktopH264Keyframe() {
	resetH264Encoder()
}

func closeH264EncoderLocked() {
	if h264Enc != nil {
		_ = h264Enc.Close()
		h264Enc = nil
	}
	h264Width = 0
	h264Height = 0
	h264FPS = 0
	h264Buf.Reset()
}

var (
	backstageH264Mu      sync.Mutex
	backstageH264Enc     *x264.Encoder
	backstageH264Buf     bytes.Buffer
	backstageH264Width   int
	backstageH264Height  int
	backstageH264FPS     int
	backstageH264Scratch []byte
)

func encodeH264Framebackstage(img *image.RGBA) ([]byte, error) {
	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()

	backstageH264Mu.Lock()
	defer backstageH264Mu.Unlock()

	if err := ensurebackstageH264EncoderLocked(width, height); err != nil {
		return nil, err
	}

	backstageH264Buf.Reset()
	if err := backstageH264Enc.Encode(img); err != nil {
		return nil, err
	}

	n := backstageH264Buf.Len()
	if n == 0 {
		return nil, nil
	}
	if cap(backstageH264Scratch) < n {
		backstageH264Scratch = make([]byte, n, n+(n/4))
	} else {
		backstageH264Scratch = backstageH264Scratch[:n]
	}
	copy(backstageH264Scratch, backstageH264Buf.Bytes())
	return backstageH264Scratch, nil
}

func resetH264Encoderbackstage() {
	backstageH264Mu.Lock()
	defer backstageH264Mu.Unlock()
	closebackstageH264EncoderLocked()
}

func RequestBackstageH264Keyframe() {
	resetH264Encoderbackstage()
}

func ensurebackstageH264EncoderLocked(width, height int) error {
	fps := activeH264FPSValue(&backstageH264TargetFPS, 60)
	if backstageH264Enc != nil && backstageH264Width == width && backstageH264Height == height && backstageH264FPS == fps {
		return nil
	}
	closebackstageH264EncoderLocked()
	opts := &x264.Options{
		Width:        width,
		Height:       height,
		FrameRate:    fps,
		Tune:         "zerolatency",
		Preset:       "veryfast",
		Profile:      "main",
		RateControl:  "crf",
		RateConstant: targetH264CRF(width, height, fps),
		LogLevel:     x264.LogError,
	}
	enc, err := x264.NewEncoder(&backstageH264Buf, opts)
	if err != nil {
		return err
	}
	backstageH264Enc = enc
	backstageH264Width = width
	backstageH264Height = height
	backstageH264FPS = fps
	return nil
}

func closebackstageH264EncoderLocked() {
	if backstageH264Enc != nil {
		_ = backstageH264Enc.Close()
		backstageH264Enc = nil
	}
	backstageH264Width = 0
	backstageH264Height = 0
	backstageH264FPS = 0
	backstageH264Buf.Reset()
}

var (
	webcamH264Mu      sync.Mutex
	webcamH264Enc     *x264.Encoder
	webcamH264Buf     bytes.Buffer
	webcamH264Width   int
	webcamH264Height  int
	webcamH264FPS     int
	webcamH264Scratch []byte
)

func encodeH264FrameWebcam(img *image.RGBA) ([]byte, error) {
	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()

	webcamH264Mu.Lock()
	defer webcamH264Mu.Unlock()

	if err := ensureWebcamH264EncoderLocked(width, height); err != nil {
		return nil, err
	}

	webcamH264Buf.Reset()
	if err := webcamH264Enc.Encode(img); err != nil {
		return nil, err
	}

	n := webcamH264Buf.Len()
	if n == 0 {
		return nil, nil
	}
	if cap(webcamH264Scratch) < n {
		webcamH264Scratch = make([]byte, n, n+(n/4))
	} else {
		webcamH264Scratch = webcamH264Scratch[:n]
	}
	copy(webcamH264Scratch, webcamH264Buf.Bytes())
	return webcamH264Scratch, nil
}

func ensureWebcamH264EncoderLocked(width, height int) error {
	fps := activeH264FPSValue(&webcamH264TargetFPS, 30)
	if webcamH264Enc != nil && webcamH264Width == width && webcamH264Height == height && webcamH264FPS == fps {
		return nil
	}
	closeWebcamH264EncoderLocked()
	opts := &x264.Options{
		Width:        width,
		Height:       height,
		FrameRate:    fps,
		Tune:         "zerolatency",
		Preset:       "veryfast",
		Profile:      "main",
		RateControl:  "crf",
		RateConstant: targetH264CRF(width, height, fps),
		LogLevel:     x264.LogError,
	}
	enc, err := x264.NewEncoder(&webcamH264Buf, opts)
	if err != nil {
		return err
	}
	webcamH264Enc = enc
	webcamH264Width = width
	webcamH264Height = height
	webcamH264FPS = fps
	return nil
}

func closeWebcamH264EncoderLocked() {
	if webcamH264Enc != nil {
		_ = webcamH264Enc.Close()
		webcamH264Enc = nil
	}
	webcamH264Width = 0
	webcamH264Height = 0
	webcamH264FPS = 0
	webcamH264Buf.Reset()
}
