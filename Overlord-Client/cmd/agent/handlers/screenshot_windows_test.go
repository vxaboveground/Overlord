//go:build windows

package handlers

import (
	"context"
	"image"
	"image/color"
	"testing"

	rt "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"

	"github.com/vmihailenco/msgpack/v5"
)

func TestCaptureScreenshotImageWindows_PrimaryOnly(t *testing.T) {
	origMonitorCountFn := monitorCountFn
	origBoundsFn := displayBoundsFn
	origCaptureFn := captureRectFn
	t.Cleanup(func() {
		monitorCountFn = origMonitorCountFn
		displayBoundsFn = origBoundsFn
		captureRectFn = origCaptureFn
	})

	monitorCountFn = func() int { return 2 }
	displayBoundsFn = func(int) image.Rectangle { return image.Rect(0, 0, 3, 2) }
	captureRectFn = func(image.Rectangle) (*image.RGBA, error) {
		img := image.NewRGBA(image.Rect(0, 0, 3, 2))
		img.SetRGBA(0, 0, color.RGBA{R: 255, A: 255})
		return img, nil
	}

	img, displayIndex, bounds, err := captureScreenshotImageWindows(false)
	if err != nil {
		t.Fatalf("captureScreenshotImageWindows(false) failed: %v", err)
	}
	if img == nil {
		t.Fatal("expected image, got nil")
	}
	if displayIndex != 0 {
		t.Fatalf("expected displayIndex 0, got %d", displayIndex)
	}
	if bounds.Dx() != 3 || bounds.Dy() != 2 {
		t.Fatalf("expected bounds 3x2, got %dx%d", bounds.Dx(), bounds.Dy())
	}
}

func TestCaptureScreenshotImageWindows_AllDisplaysStitched(t *testing.T) {
	origMonitorCountFn := monitorCountFn
	origBoundsFn := displayBoundsFn
	origCaptureFn := captureRectFn
	t.Cleanup(func() {
		monitorCountFn = origMonitorCountFn
		displayBoundsFn = origBoundsFn
		captureRectFn = origCaptureFn
	})

	monitorCountFn = func() int { return 2 }
	displayBoundsFn = func(idx int) image.Rectangle {
		if idx == 0 {
			return image.Rect(0, 0, 2, 2)
		}
		return image.Rect(2, 0, 4, 2)
	}
	captureRectFn = func(bounds image.Rectangle) (*image.RGBA, error) {
		img := image.NewRGBA(image.Rect(0, 0, 2, 2))
		if bounds.Min.X == 0 {
			img.SetRGBA(0, 0, color.RGBA{R: 255, A: 255})
		} else {
			img.SetRGBA(0, 0, color.RGBA{G: 255, A: 255})
		}
		return img, nil
	}

	img, displayIndex, bounds, err := captureScreenshotImageWindows(true)
	if err != nil {
		t.Fatalf("captureScreenshotImageWindows(true) failed: %v", err)
	}
	if img == nil {
		t.Fatal("expected stitched image, got nil")
	}
	if displayIndex != 0 {
		t.Fatalf("expected displayIndex 0, got %d", displayIndex)
	}
	if bounds.Dx() != 4 || bounds.Dy() != 2 {
		t.Fatalf("expected stitched bounds 4x2, got %dx%d", bounds.Dx(), bounds.Dy())
	}

	left := img.RGBAAt(0, 0)
	right := img.RGBAAt(2, 0)
	if left.R != 255 || left.G != 0 {
		t.Fatalf("expected left monitor red marker, got %+v", left)
	}
	if right.G != 255 || right.R != 0 {
		t.Fatalf("expected right monitor green marker, got %+v", right)
	}
}

func TestCaptureScreenshotImageWindows_NoDisplays(t *testing.T) {
	origMonitorCountFn := monitorCountFn
	t.Cleanup(func() {
		monitorCountFn = origMonitorCountFn
	})

	monitorCountFn = func() int { return 0 }

	img, _, _, err := captureScreenshotImageWindows(false)
	if err == nil {
		t.Fatal("expected error for no displays, got nil")
	}
	if img != nil {
		t.Fatal("expected nil image on error")
	}
}

func TestHandleScreenshot_RepeatedRequestsDoNotEmitLiveFrames(t *testing.T) {
	origMonitorCountFn := monitorCountFn
	origBoundsFn := displayBoundsFn
	origCaptureFn := captureRectFn
	t.Cleanup(func() {
		monitorCountFn = origMonitorCountFn
		displayBoundsFn = origBoundsFn
		captureRectFn = origCaptureFn
	})

	monitorCountFn = func() int { return 1 }
	displayBoundsFn = func(int) image.Rectangle { return image.Rect(0, 0, 2, 2) }
	captureRectFn = func(image.Rectangle) (*image.RGBA, error) {
		img := image.NewRGBA(image.Rect(0, 0, 2, 2))
		img.SetRGBA(0, 0, color.RGBA{B: 255, A: 255})
		return img, nil
	}

	ctx := context.Background()
	writer := &testWriter{}
	for i, commandID := range []string{"cmd-1", "cmd-2"} {
		if err := HandleScreenshot(ctx, &rt.Env{Conn: writer}, commandID, false); err != nil {
			t.Fatalf("HandleScreenshot request %d failed: %v", i+1, err)
		}
	}
	if len(writer.msgs) != 4 {
		t.Fatalf("expected 4 result messages without live frame emission, got %d", len(writer.msgs))
	}

	for i := range 2 {
		var screenshotResult wire.ScreenshotResult
		if err := msgpack.Unmarshal(writer.msgs[i*2], &screenshotResult); err != nil {
			t.Fatalf("unmarshal screenshot_result %d: %v", i+1, err)
		}
		if screenshotResult.Type != "screenshot_result" {
			t.Fatalf("expected screenshot_result for request %d, got %q", i+1, screenshotResult.Type)
		}

		var commandResult wire.CommandResult
		if err := msgpack.Unmarshal(writer.msgs[i*2+1], &commandResult); err != nil {
			t.Fatalf("unmarshal command_result %d: %v", i+1, err)
		}
		if commandResult.Type != "command_result" || !commandResult.OK {
			t.Fatalf("expected successful command_result for request %d, got %+v", i+1, commandResult)
		}
	}
}
