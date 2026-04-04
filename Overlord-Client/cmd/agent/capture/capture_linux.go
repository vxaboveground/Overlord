//go:build linux

package capture

import (
	"image"
	"log"
	"os"
	"sync"
	"sync/atomic"

	"github.com/kbinani/screenshot"
)

var isWaylandSession = os.Getenv("XDG_SESSION_TYPE") == "wayland" || os.Getenv("WAYLAND_DISPLAY") != ""

var (
	x11Disabled       atomic.Bool
	x11BlackCount     atomic.Int64
	x11CheckOnce      sync.Once
	x11MaxBlackFrames int64 = 3
)

func init() {
	if isWaylandSession {
		log.Printf("capture: Wayland session detected (XDG_SESSION_TYPE=%s WAYLAND_DISPLAY=%s), using screenshot library (D-Bus portal)",
			os.Getenv("XDG_SESSION_TYPE"), os.Getenv("WAYLAND_DISPLAY"))
	}
}

var activeDisplays = func() int {
	if !isWaylandSession && !x11Disabled.Load() {
		if n := x11DisplayCount(); n > 0 {
			return n
		}
	}
	return screenshot.NumActiveDisplays()
}

var captureDisplayFn = func(display int) (*image.RGBA, error) {
	if isWaylandSession || x11Disabled.Load() {
		return captureViaLibrary(display)
	}

	img, err := x11CaptureDisplay(display)
	if err != nil {
		log.Printf("x11 capture: error, falling back to screenshot library: %v", err)
		return captureViaLibrary(display)
	}

	if isAllBlack(img) {
		n := x11BlackCount.Add(1)
		if n >= x11MaxBlackFrames {
			log.Printf("x11 capture: %d consecutive all-black frames, disabling X11 capture permanently", n)
			x11Disabled.Store(true)
			x11Reset()
			return captureViaLibrary(display)
		}
		libImg, libErr := captureViaLibrary(display)
		if libErr == nil && !isAllBlack(libImg) {
			log.Printf("x11 capture: X11 returned black but screenshot library works, disabling X11 capture")
			x11Disabled.Store(true)
			x11Reset()
			return libImg, nil
		}
		return img, nil
	}
	x11BlackCount.Store(0)
	return img, nil
}

func captureViaLibrary(display int) (*image.RGBA, error) {
	bounds := screenshot.GetDisplayBounds(display)
	img, err := screenshot.CaptureRect(bounds)
	if err != nil {
		return nil, err
	}
	if img.Rect.Min.X != 0 || img.Rect.Min.Y != 0 {
		img.Rect = image.Rect(0, 0, img.Rect.Dx(), img.Rect.Dy())
	}
	return img, nil
}

func isAllBlack(img *image.RGBA) bool {
	if img == nil {
		return true
	}
	pix := img.Pix
	stride := img.Stride
	w := img.Rect.Dx()
	h := img.Rect.Dy()
	if w == 0 || h == 0 {
		return true
	}
	stepX := w / 4
	stepY := h / 4
	if stepX < 1 {
		stepX = 1
	}
	if stepY < 1 {
		stepY = 1
	}
	for y := stepY / 2; y < h; y += stepY {
		row := y * stride
		for x := stepX / 2; x < w; x += stepX {
			off := row + x*4
			if off+2 >= len(pix) {
				continue
			}
			if pix[off] != 0 || pix[off+1] != 0 || pix[off+2] != 0 {
				return false
			}
		}
	}
	return true
}

func displayCount() int {
	if !isWaylandSession && !x11Disabled.Load() {
		if n := x11DisplayCount(); n > 0 {
			return n
		}
	}
	return screenshot.NumActiveDisplays()
}
