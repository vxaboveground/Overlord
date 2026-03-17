//go:build windows

package capture

import (
	"image"
	"image/color"
	"sync/atomic"
	"unsafe"
)

var (
	cursorCaptureEnabled atomic.Bool
)

func SetCursorCapture(enabled bool) {
	cursorCaptureEnabled.Store(enabled)
}

var (
	procGetCursorPos  = user32.NewProc("GetCursorPos")
	procGetCursorInfo = user32.NewProc("GetCursorInfo")
	procGetIconInfo   = user32.NewProc("GetIconInfo")
	procDrawIconEx    = user32.NewProc("DrawIconEx")
)

const (
	CURSOR_SHOWING = 0x00000001
	DI_NORMAL      = 0x0003
	DI_DEFAULTSIZE = 0x0008
)

type point struct {
	x int32
	y int32
}

type cursorInfo struct {
	cbSize      uint32
	flags       uint32
	hCursor     uintptr
	ptScreenPos point
}

type iconInfo struct {
	fIcon    uint32
	xHotspot uint32
	yHotspot uint32
	hbmMask  uintptr
	hbmColor uintptr
}

func getCursorPosition() (x, y int32, visible bool) {
	var ci cursorInfo
	ci.cbSize = uint32(unsafe.Sizeof(ci))

	ret, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci)))
	if ret == 0 {
		return 0, 0, false
	}

	visible = (ci.flags & CURSOR_SHOWING) != 0
	return ci.ptScreenPos.x, ci.ptScreenPos.y, visible
}

func drawCursor(img *image.RGBA, cursorX, cursorY int32, bounds image.Rectangle) {
	imgX := int(cursorX) - bounds.Min.X
	imgY := int(cursorY) - bounds.Min.Y

	if imgX < 0 || imgY < 0 || imgX >= img.Bounds().Dx() || imgY >= img.Bounds().Dy() {
		return
	}

	cursorPattern := []struct {
		x, y int
		c    color.RGBA
	}{
		{0, 0, color.RGBA{0, 0, 0, 255}},
		{0, 1, color.RGBA{0, 0, 0, 255}},
		{0, 2, color.RGBA{0, 0, 0, 255}},
		{0, 3, color.RGBA{0, 0, 0, 255}},
		{0, 4, color.RGBA{0, 0, 0, 255}},
		{0, 5, color.RGBA{0, 0, 0, 255}},
		{0, 6, color.RGBA{0, 0, 0, 255}},
		{0, 7, color.RGBA{0, 0, 0, 255}},
		{0, 8, color.RGBA{0, 0, 0, 255}},
		{0, 9, color.RGBA{0, 0, 0, 255}},
		{0, 10, color.RGBA{0, 0, 0, 255}},
		{0, 11, color.RGBA{0, 0, 0, 255}},
		{1, 0, color.RGBA{0, 0, 0, 255}},
		{1, 10, color.RGBA{0, 0, 0, 255}},
		{2, 0, color.RGBA{0, 0, 0, 255}},
		{2, 9, color.RGBA{0, 0, 0, 255}},
		{3, 0, color.RGBA{0, 0, 0, 255}},
		{3, 8, color.RGBA{0, 0, 0, 255}},
		{3, 9, color.RGBA{0, 0, 0, 255}},
		{4, 0, color.RGBA{0, 0, 0, 255}},
		{4, 7, color.RGBA{0, 0, 0, 255}},
		{4, 8, color.RGBA{0, 0, 0, 255}},
		{5, 0, color.RGBA{0, 0, 0, 255}},
		{5, 6, color.RGBA{0, 0, 0, 255}},
		{5, 7, color.RGBA{0, 0, 0, 255}},
		{5, 13, color.RGBA{0, 0, 0, 255}},
		{6, 0, color.RGBA{0, 0, 0, 255}},
		{6, 5, color.RGBA{0, 0, 0, 255}},
		{6, 6, color.RGBA{0, 0, 0, 255}},
		{6, 12, color.RGBA{0, 0, 0, 255}},
		{6, 13, color.RGBA{0, 0, 0, 255}},
		{7, 0, color.RGBA{0, 0, 0, 255}},
		{7, 4, color.RGBA{0, 0, 0, 255}},
		{7, 5, color.RGBA{0, 0, 0, 255}},
		{7, 11, color.RGBA{0, 0, 0, 255}},
		{7, 12, color.RGBA{0, 0, 0, 255}},
		{8, 4, color.RGBA{0, 0, 0, 255}},
		{8, 10, color.RGBA{0, 0, 0, 255}},
		{8, 11, color.RGBA{0, 0, 0, 255}},
		{9, 4, color.RGBA{0, 0, 0, 255}},
		{9, 9, color.RGBA{0, 0, 0, 255}},
		{9, 10, color.RGBA{0, 0, 0, 255}},
		{10, 8, color.RGBA{0, 0, 0, 255}},
		{10, 9, color.RGBA{0, 0, 0, 255}},
		{11, 7, color.RGBA{0, 0, 0, 255}},
		{11, 8, color.RGBA{0, 0, 0, 255}},
		{12, 6, color.RGBA{0, 0, 0, 255}},
		{12, 7, color.RGBA{0, 0, 0, 255}},

		{1, 1, color.RGBA{255, 255, 255, 255}},
		{1, 2, color.RGBA{255, 255, 255, 255}},
		{1, 3, color.RGBA{255, 255, 255, 255}},
		{1, 4, color.RGBA{255, 255, 255, 255}},
		{1, 5, color.RGBA{255, 255, 255, 255}},
		{1, 6, color.RGBA{255, 255, 255, 255}},
		{1, 7, color.RGBA{255, 255, 255, 255}},
		{1, 8, color.RGBA{255, 255, 255, 255}},
		{1, 9, color.RGBA{255, 255, 255, 255}},
		{2, 1, color.RGBA{255, 255, 255, 255}},
		{2, 2, color.RGBA{255, 255, 255, 255}},
		{2, 3, color.RGBA{255, 255, 255, 255}},
		{2, 4, color.RGBA{255, 255, 255, 255}},
		{2, 5, color.RGBA{255, 255, 255, 255}},
		{2, 6, color.RGBA{255, 255, 255, 255}},
		{2, 7, color.RGBA{255, 255, 255, 255}},
		{2, 8, color.RGBA{255, 255, 255, 255}},
		{3, 1, color.RGBA{255, 255, 255, 255}},
		{3, 2, color.RGBA{255, 255, 255, 255}},
		{3, 3, color.RGBA{255, 255, 255, 255}},
		{3, 4, color.RGBA{255, 255, 255, 255}},
		{3, 5, color.RGBA{255, 255, 255, 255}},
		{3, 6, color.RGBA{255, 255, 255, 255}},
		{3, 7, color.RGBA{255, 255, 255, 255}},
		{4, 1, color.RGBA{255, 255, 255, 255}},
		{4, 2, color.RGBA{255, 255, 255, 255}},
		{4, 3, color.RGBA{255, 255, 255, 255}},
		{4, 4, color.RGBA{255, 255, 255, 255}},
		{4, 5, color.RGBA{255, 255, 255, 255}},
		{4, 6, color.RGBA{255, 255, 255, 255}},
		{5, 1, color.RGBA{255, 255, 255, 255}},
		{5, 2, color.RGBA{255, 255, 255, 255}},
		{5, 3, color.RGBA{255, 255, 255, 255}},
		{5, 4, color.RGBA{255, 255, 255, 255}},
		{5, 5, color.RGBA{255, 255, 255, 255}},
		{5, 11, color.RGBA{255, 255, 255, 255}},
		{5, 12, color.RGBA{255, 255, 255, 255}},
		{6, 1, color.RGBA{255, 255, 255, 255}},
		{6, 2, color.RGBA{255, 255, 255, 255}},
		{6, 3, color.RGBA{255, 255, 255, 255}},
		{6, 4, color.RGBA{255, 255, 255, 255}},
		{6, 10, color.RGBA{255, 255, 255, 255}},
		{6, 11, color.RGBA{255, 255, 255, 255}},
		{7, 1, color.RGBA{255, 255, 255, 255}},
		{7, 2, color.RGBA{255, 255, 255, 255}},
		{7, 3, color.RGBA{255, 255, 255, 255}},
		{7, 9, color.RGBA{255, 255, 255, 255}},
		{7, 10, color.RGBA{255, 255, 255, 255}},
		{8, 5, color.RGBA{255, 255, 255, 255}},
		{8, 6, color.RGBA{255, 255, 255, 255}},
		{8, 7, color.RGBA{255, 255, 255, 255}},
		{8, 8, color.RGBA{255, 255, 255, 255}},
		{8, 9, color.RGBA{255, 255, 255, 255}},
		{9, 5, color.RGBA{255, 255, 255, 255}},
		{9, 6, color.RGBA{255, 255, 255, 255}},
		{9, 7, color.RGBA{255, 255, 255, 255}},
		{9, 8, color.RGBA{255, 255, 255, 255}},
		{10, 6, color.RGBA{255, 255, 255, 255}},
		{10, 7, color.RGBA{255, 255, 255, 255}},
		{11, 6, color.RGBA{255, 255, 255, 255}},
	}

	for _, p := range cursorPattern {
		px := imgX + p.x
		py := imgY + p.y
		if px >= 0 && px < img.Bounds().Dx() && py >= 0 && py < img.Bounds().Dy() {
			img.SetRGBA(px, py, p.c)
		}
	}
}

func DrawCursorOnDC(hdc uintptr, captureBounds image.Rectangle) bool {
	return DrawCursorOnDCScaled(hdc, captureBounds, 1.0, 1.0)
}

func DrawCursorOnDCScaled(hdc uintptr, captureBounds image.Rectangle, scaleX, scaleY float64) bool {
	if !cursorCaptureEnabled.Load() || hdc == 0 {
		return false
	}
	var ci cursorInfo
	ci.cbSize = uint32(unsafe.Sizeof(ci))
	ret, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci)))
	if ret == 0 || (ci.flags&CURSOR_SHOWING) == 0 || ci.hCursor == 0 {
		return false
	}
	var icon iconInfo
	ret, _, _ = procGetIconInfo.Call(ci.hCursor, uintptr(unsafe.Pointer(&icon)))
	if ret == 0 {
		return false
	}
	if icon.hbmMask != 0 {
		defer deleteObject(icon.hbmMask)
	}
	if icon.hbmColor != 0 {
		defer deleteObject(icon.hbmColor)
	}

	// Map from screen space into the (possibly scaled) DC space.
	x := int32(float64(ci.ptScreenPos.x-int32(captureBounds.Min.X))*scaleX) - int32(icon.xHotspot)
	y := int32(float64(ci.ptScreenPos.y-int32(captureBounds.Min.Y))*scaleY) - int32(icon.yHotspot)
	ret, _, _ = procDrawIconEx.Call(
		hdc,
		uintptr(x),
		uintptr(y),
		ci.hCursor,
		0,
		0,
		0,
		0,
		uintptr(DI_NORMAL),
	)
	return ret != 0
}

func DrawCursorOnImage(img *image.RGBA, captureBounds image.Rectangle) {
	if !cursorCaptureEnabled.Load() {
		return
	}

	x, y, visible := getCursorPosition()
	if visible {
		drawCursor(img, x, y, captureBounds)
	}
}
