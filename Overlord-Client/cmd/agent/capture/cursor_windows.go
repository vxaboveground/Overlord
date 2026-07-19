//go:build windows

package capture

import (
	"bytes"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"sync"
	"sync/atomic"
	"unsafe"
)

var (
	cursorCaptureEnabled  atomic.Bool
	cursorMetadataEnabled atomic.Bool
	cursorGeneration      atomic.Uint64
)

func SetCursorCapture(enabled bool) {
	// Cursor pixels are transported separately. Keeping frame compositing off
	// preserves direct DXGI/video encoding and avoids a full-frame copy.
	cursorMetadataEnabled.Store(enabled)
	cursorCaptureEnabled.Store(false)
	if enabled {
		cursorGeneration.Add(1)
	}
}

var (
	procGetCursorPos  = user32.NewProc("GetCursorPos")
	procGetCursorInfo = user32.NewProc("GetCursorInfo")
	procGetIconInfo   = user32.NewProc("GetIconInfo")
	procDrawIconEx    = user32.NewProc("DrawIconEx")
	procGetObjectW    = gdi32.NewProc("GetObjectW")
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

type gdiBitmap struct {
	bmType       int32
	bmWidth      int32
	bmHeight     int32
	bmWidthBytes int32
	bmPlanes     uint16
	bmBitsPixel  uint16
	bmBits       unsafe.Pointer
}

type cursorShape struct {
	width    int
	height   int
	hotspotX int
	hotspotY int
	image    []byte
}

var cursorShapeCache struct {
	sync.Mutex
	hCursor uintptr
	shape   cursorShape
}

func queryCursor() (cursorInfo, bool) {
	var ci cursorInfo
	ci.cbSize = uint32(unsafe.Sizeof(ci))
	ret, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci)))
	return ci, ret != 0
}

func getCursorPosition() (x, y int32, visible bool) {
	ci, ok := queryCursor()
	if !ok {
		return 0, 0, false
	}
	return ci.ptScreenPos.x, ci.ptScreenPos.y, (ci.flags & CURSOR_SHOWING) != 0
}

func DesktopCursorState(display, frameWidth, frameHeight int) DesktopCursorMetadata {
	if !cursorMetadataEnabled.Load() {
		return DesktopCursorMetadata{}
	}
	state := DesktopCursorMetadata{
		Enabled:    true,
		Generation: cursorGeneration.Load(),
	}
	ci, ok := queryCursor()
	if !ok {
		return state
	}
	state.Shape = uint64(ci.hCursor)
	if ci.hCursor != 0 {
		if shape, err := getCursorShape(ci.hCursor); err == nil {
			state.CursorWidth = shape.width
			state.CursorHeight = shape.height
			state.HotspotX = shape.hotspotX
			state.HotspotY = shape.hotspotY
			state.Image = shape.image
		}
	}

	bounds := DisplayBounds(display)
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		return state
	}
	if frameWidth <= 0 {
		frameWidth = bounds.Dx()
	}
	if frameHeight <= 0 {
		frameHeight = bounds.Dy()
	}
	if state.CursorWidth > 0 && state.CursorHeight > 0 {
		state.CursorWidth = scaleCursorMetric(state.CursorWidth, frameWidth, bounds.Dx())
		state.CursorHeight = scaleCursorMetric(state.CursorHeight, frameHeight, bounds.Dy())
		state.HotspotX = scaleCursorMetric(state.HotspotX, frameWidth, bounds.Dx())
		state.HotspotY = scaleCursorMetric(state.HotspotY, frameHeight, bounds.Dy())
		if state.HotspotX >= state.CursorWidth {
			state.HotspotX = state.CursorWidth - 1
		}
		if state.HotspotY >= state.CursorHeight {
			state.HotspotY = state.CursorHeight - 1
		}
	}
	showing := (ci.flags & CURSOR_SHOWING) != 0
	if !showing ||
		ci.ptScreenPos.x < int32(bounds.Min.X) || ci.ptScreenPos.x >= int32(bounds.Max.X) ||
		ci.ptScreenPos.y < int32(bounds.Min.Y) || ci.ptScreenPos.y >= int32(bounds.Max.Y) {
		return state
	}
	state.X = int(ci.ptScreenPos.x-int32(bounds.Min.X)) * frameWidth / bounds.Dx()
	state.Y = int(ci.ptScreenPos.y-int32(bounds.Min.Y)) * frameHeight / bounds.Dy()
	state.Visible = true
	return state
}

func scaleCursorMetric(value, frameSize, captureSize int) int {
	if value <= 0 || frameSize <= 0 || captureSize <= 0 {
		return 0
	}
	scaled := (value*frameSize + captureSize/2) / captureSize
	if scaled < 1 {
		return 1
	}
	return scaled
}

func getCursorShape(hCursor uintptr) (cursorShape, error) {
	cursorShapeCache.Lock()
	defer cursorShapeCache.Unlock()
	if cursorShapeCache.hCursor == hCursor && len(cursorShapeCache.shape.image) != 0 {
		return cursorShapeCache.shape, nil
	}
	shape, err := extractCursorShape(hCursor)
	if err != nil {
		return cursorShape{}, err
	}
	cursorShapeCache.hCursor = hCursor
	cursorShapeCache.shape = shape
	return shape, nil
}

func extractCursorShape(hCursor uintptr) (cursorShape, error) {
	if hCursor == 0 {
		return cursorShape{}, fmt.Errorf("cursor handle is null")
	}
	var icon iconInfo
	ret, _, callErr := procGetIconInfo.Call(hCursor, uintptr(unsafe.Pointer(&icon)))
	if ret == 0 {
		return cursorShape{}, fmt.Errorf("GetIconInfo: %w", callErr)
	}
	if icon.hbmMask != 0 {
		defer deleteObject(icon.hbmMask)
	}
	if icon.hbmColor != 0 {
		defer deleteObject(icon.hbmColor)
	}

	width, height, err := cursorBitmapDimensions(icon)
	if err != nil {
		return cursorShape{}, err
	}
	black, err := renderCursorOnBackground(hCursor, width, height, 0)
	if err != nil {
		return cursorShape{}, err
	}
	white, err := renderCursorOnBackground(hCursor, width, height, 255)
	if err != nil {
		return cursorShape{}, err
	}
	img := reconstructCursorRGBA(black, white, width, height)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		return cursorShape{}, fmt.Errorf("encode cursor PNG: %w", err)
	}
	return cursorShape{
		width:    width,
		height:   height,
		hotspotX: int(icon.xHotspot),
		hotspotY: int(icon.yHotspot),
		image:    encoded.Bytes(),
	}, nil
}

func cursorBitmapDimensions(icon iconInfo) (int, int, error) {
	if icon.hbmColor != 0 {
		if width, height, ok := bitmapDimensions(icon.hbmColor); ok {
			return width, height, validateCursorDimensions(width, height)
		}
	}
	if icon.hbmMask != 0 {
		if width, maskHeight, ok := bitmapDimensions(icon.hbmMask); ok {
			height := maskHeight
			if icon.hbmColor == 0 {
				// A monochrome cursor stores its AND and XOR masks vertically.
				height /= 2
			}
			return width, height, validateCursorDimensions(width, height)
		}
	}
	return 0, 0, fmt.Errorf("cursor has no readable bitmap")
}

func bitmapDimensions(hBitmap uintptr) (int, int, bool) {
	var bitmap gdiBitmap
	ret, _, _ := procGetObjectW.Call(
		hBitmap,
		uintptr(unsafe.Sizeof(bitmap)),
		uintptr(unsafe.Pointer(&bitmap)),
	)
	if ret == 0 {
		return 0, 0, false
	}
	width, height := int(bitmap.bmWidth), int(bitmap.bmHeight)
	if width < 0 {
		width = -width
	}
	if height < 0 {
		height = -height
	}
	return width, height, true
}

func validateCursorDimensions(width, height int) error {
	if width <= 0 || height <= 0 || width > 1024 || height > 1024 {
		return fmt.Errorf("invalid cursor dimensions %dx%d", width, height)
	}
	return nil
}

func renderCursorOnBackground(hCursor uintptr, width, height int, background byte) ([]byte, error) {
	hdcScreen := getDC(0)
	if hdcScreen == 0 {
		return nil, fmt.Errorf("GetDC failed")
	}
	defer releaseDC(0, hdcScreen)
	hdc := createCompatibleDC(hdcScreen)
	if hdc == 0 {
		return nil, fmt.Errorf("CreateCompatibleDC failed")
	}
	defer deleteDC(hdc)

	bmi := bitmapInfo{bmiHeader: bitmapInfoHeader{
		biSize:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		biWidth:       int32(width),
		biHeight:      -int32(height),
		biPlanes:      1,
		biBitCount:    32,
		biCompression: BI_RGB,
	}}
	var bits unsafe.Pointer
	dib := createDIBSection(hdcScreen, &bmi, DIB_RGB_COLORS, &bits)
	if dib == 0 || bits == nil {
		return nil, fmt.Errorf("CreateDIBSection failed")
	}
	defer deleteObject(dib)
	previous := selectObject(hdc, dib)
	if previous == 0 {
		return nil, fmt.Errorf("SelectObject failed")
	}
	defer selectObject(hdc, previous)

	pixels := unsafe.Slice((*byte)(bits), width*height*4)
	for offset := 0; offset < len(pixels); offset += 4 {
		pixels[offset] = background
		pixels[offset+1] = background
		pixels[offset+2] = background
		pixels[offset+3] = 255
	}
	ret, _, callErr := procDrawIconEx.Call(
		hdc,
		0,
		0,
		hCursor,
		uintptr(width),
		uintptr(height),
		0,
		0,
		uintptr(DI_NORMAL),
	)
	if ret == 0 {
		return nil, fmt.Errorf("DrawIconEx: %w", callErr)
	}
	result := make([]byte, len(pixels))
	copy(result, pixels)
	return result, nil
}

func reconstructCursorRGBA(black, white []byte, width, height int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for src, dst := 0, 0; src+3 < len(black) && src+3 < len(white); src, dst = src+4, dst+4 {
		blue := int(black[src])
		green := int(black[src+1])
		red := int(black[src+2])
		transmission := max(
			int(white[src])-blue,
			int(white[src+1])-green,
			int(white[src+2])-red,
		)
		if transmission < 0 {
			transmission = 0
		} else if transmission > 255 {
			transmission = 255
		}
		alpha := 255 - transmission
		img.Pix[dst+3] = byte(alpha)
		if alpha == 0 {
			continue
		}
		img.Pix[dst] = unpremultiplyCursorChannel(red, alpha)
		img.Pix[dst+1] = unpremultiplyCursorChannel(green, alpha)
		img.Pix[dst+2] = unpremultiplyCursorChannel(blue, alpha)
	}
	return img
}

func unpremultiplyCursorChannel(value, alpha int) byte {
	value = (value*255 + alpha/2) / alpha
	if value > 255 {
		value = 255
	}
	return byte(value)
}

func drawCursor(img *image.RGBA, cursorX, cursorY int32, bounds image.Rectangle) {
	if img == nil {
		return
	}
	ci, ok := queryCursor()
	if !ok || ci.hCursor == 0 {
		return
	}
	shape, err := getCursorShape(ci.hCursor)
	if err != nil {
		return
	}
	cursorImage, err := png.Decode(bytes.NewReader(shape.image))
	if err != nil {
		return
	}
	x := int(cursorX) - bounds.Min.X - shape.hotspotX
	y := int(cursorY) - bounds.Min.Y - shape.hotspotY
	target := image.Rect(x, y, x+shape.width, y+shape.height)
	draw.Draw(img, target, cursorImage, cursorImage.Bounds().Min, draw.Over)
}

func DrawCursorOnDC(hdc uintptr, captureBounds image.Rectangle) bool {
	return DrawCursorOnDCScaled(hdc, captureBounds, 1.0, 1.0)
}

func DrawCursorOnDCScaled(hdc uintptr, captureBounds image.Rectangle, scaleX, scaleY float64) bool {
	if !cursorCaptureEnabled.Load() || hdc == 0 {
		return false
	}
	ci, ok := queryCursor()
	if !ok || (ci.flags&CURSOR_SHOWING) == 0 || ci.hCursor == 0 {
		return false
	}
	var icon iconInfo
	ret, _, _ := procGetIconInfo.Call(ci.hCursor, uintptr(unsafe.Pointer(&icon)))
	if ret == 0 {
		return false
	}
	if icon.hbmMask != 0 {
		defer deleteObject(icon.hbmMask)
	}
	if icon.hbmColor != 0 {
		defer deleteObject(icon.hbmColor)
	}

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
