//go:build windows

package capture

import (
	"image"
	"log"
	"math"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var (
	user32                     = syscall.NewLazyDLL("user32.dll")
	gdi32                      = syscall.NewLazyDLL("gdi32.dll")
	shcore                     = syscall.NewLazyDLL("shcore.dll")
	kernel32                   = syscall.NewLazyDLL("kernel32.dll")
	procGetDC                  = user32.NewProc("GetDC")
	procReleaseDC              = user32.NewProc("ReleaseDC")
	procGetSystemMetrics       = user32.NewProc("GetSystemMetrics")
	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateDCW              = gdi32.NewProc("CreateDCW")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procCreateDIBSection       = gdi32.NewProc("CreateDIBSection")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procStretchBlt             = gdi32.NewProc("StretchBlt")
	procSetStretchBltMode      = gdi32.NewProc("SetStretchBltMode")
	procSetProcessDpiAwareness = shcore.NewProc("SetProcessDpiAwareness")
)

const (
	SM_CXSCREEN                   = 0
	SM_CYSCREEN                   = 1
	SM_XVIRTUALSCREEN             = 76
	SM_YVIRTUALSCREEN             = 77
	SM_CXVIRTUALSCREEN            = 78
	SM_CYVIRTUALSCREEN            = 79
	SRCCOPY                       = 0x00CC0020
	CAPTUREBLT                    = 0x40000000
	BI_RGB                        = 0
	DIB_RGB_COLORS                = 0
	PROCESS_PER_MONITOR_DPI_AWARE = 2
	COLORONCOLOR                  = 3
)

type bitmapInfoHeader struct {
	biSize          uint32
	biWidth         int32
	biHeight        int32
	biPlanes        uint16
	biBitCount      uint16
	biCompression   uint32
	biSizeImage     uint32
	biXPelsPerMeter int32
	biYPelsPerMeter int32
	biClrUsed       uint32
	biClrImportant  uint32
}

type bitmapInfo struct {
	bmiHeader bitmapInfoHeader
	redMask   uint32
	greenMask uint32
	blueMask  uint32
	alphaMask uint32
}

func getSystemMetric(i int32) int32 {
	r, _, _ := procGetSystemMetrics.Call(uintptr(i))
	return int32(r)
}

func getDC(hwnd uintptr) uintptr {
	dc, _, _ := procGetDC.Call(hwnd)
	return dc
}

func releaseDC(hwnd, hdc uintptr) {
	_, _, _ = procReleaseDC.Call(hwnd, hdc)
}

func createCompatibleDC(hdc uintptr) uintptr {
	r, _, _ := procCreateCompatibleDC.Call(hdc)
	return r
}

func createDisplayDC() uintptr {
	displayName := syscall.StringToUTF16Ptr("DISPLAY")
	r, _, _ := procCreateDCW.Call(uintptr(unsafe.Pointer(displayName)), 0, 0, 0)
	return r
}

func deleteDC(hdc uintptr) {
	_, _, _ = procDeleteDC.Call(hdc)
}

func createCompatibleBitmap(hdc uintptr, w, h int32) uintptr {
	r, _, _ := procCreateCompatibleBitmap.Call(hdc, uintptr(w), uintptr(h))
	return r
}

func createDIBSection(hdc uintptr, bmi *bitmapInfo, usage uint32, bits *unsafe.Pointer) uintptr {
	r, _, _ := procCreateDIBSection.Call(hdc, uintptr(unsafe.Pointer(bmi)), uintptr(usage), uintptr(unsafe.Pointer(bits)), 0, 0)
	return r
}

func deleteObject(obj uintptr) {
	_, _, _ = procDeleteObject.Call(obj)
}

func selectObject(hdc, hgdiobj uintptr) uintptr {
	r, _, _ := procSelectObject.Call(hdc, hgdiobj)
	return r
}

func bitBlt(hdcDest uintptr, x, y, cx, cy int32, hdcSrc uintptr, x1, y1 int32, rop uint32) bool {
	r, _, _ := procBitBlt.Call(hdcDest, uintptr(x), uintptr(y), uintptr(cx), uintptr(cy), hdcSrc, uintptr(x1), uintptr(y1), uintptr(rop))
	return r != 0
}

func stretchBlt(hdcDest uintptr, xDest, yDest, wDest, hDest int32, hdcSrc uintptr, xSrc, ySrc, wSrc, hSrc int32, rop uint32) bool {
	r, _, _ := procStretchBlt.Call(hdcDest, uintptr(xDest), uintptr(yDest), uintptr(wDest), uintptr(hDest), hdcSrc, uintptr(xSrc), uintptr(ySrc), uintptr(wSrc), uintptr(hSrc), uintptr(rop))
	return r != 0
}

func setStretchBltMode(hdc uintptr, mode int32) {
	_, _, _ = procSetStretchBltMode.Call(hdc, uintptr(mode))
}

func bitBltWithFallback(hdcMem, hdcScreen uintptr, bounds image.Rectangle, w, h int) bool {
	return bitBlt(hdcMem, 0, 0, int32(w), int32(h), hdcScreen, int32(bounds.Min.X), int32(bounds.Min.Y), SRCCOPY)
}

func stretchBltCapture(hdcMem, hdcScreen uintptr, bounds image.Rectangle, srcW, srcH, dstW, dstH int) bool {
	setStretchBltMode(hdcMem, COLORONCOLOR)
	return stretchBlt(hdcMem, 0, 0, int32(dstW), int32(dstH), hdcScreen, int32(bounds.Min.X), int32(bounds.Min.Y), int32(srcW), int32(srcH), SRCCOPY)
}

var dpiAwareOnce sync.Once

func setDPIAware() {
	dpiAwareOnce.Do(func() {

		if procSetProcessDpiAwareness.Find() == nil {
			procSetProcessDpiAwareness.Call(uintptr(PROCESS_PER_MONITOR_DPI_AWARE))
		}
	})
}

var (
	captureCount     atomic.Int64
	bitbltNs         atomic.Int64
	convertNs        atomic.Int64
	lastCaptureLogNs atomic.Int64
	scaleOnce        sync.Once
	cachedScale      float64
	maxResHeight     atomic.Int64 // 0 = default (1080), -1 = native, >0 = specific max height
	lastCapScale     atomic.Uint64
	state            capState
	captureMu        sync.Mutex
)

var captureDisplayFn = func(display int) (*image.RGBA, error) {
	if useDesktopDuplication() {
		img, err := captureDisplayDXGI(display)
		if err == nil && img != nil {
			return img, nil
		}
		if err != nil {
			log.Printf("capture: dxgi duplication failed: %v (falling back to bitblt)", err)
		}
	}
	return captureDisplayBitBlt(display)
}

func captureDisplayBitBlt(display int) (*image.RGBA, error) {

	captureMu.Lock()
	defer captureMu.Unlock()

	setDPIAware()

	maxDisplays := displayCount()
	if display < 0 || display >= maxDisplays {
		display = 0
	}

	mons := monitorList()
	if display >= len(mons) {
		display = 0
	}
	mon := mons[display]

	bounds := resolveBounds(mon)
	srcW := bounds.Dx()
	srcH := bounds.Dy()
	if srcW <= 0 || srcH <= 0 {
		ResetMonitorCache()
		mons = monitorList()
		if display >= len(mons) {
			display = 0
		}
		if display < len(mons) {
			mon = mons[display]
			bounds = resolveBounds(mon)
			srcW = bounds.Dx()
			srcH = bounds.Dy()
		}
		if srcW <= 0 || srcH <= 0 {
			return nil, syscall.EINVAL
		}
	}

	userScale := effectiveScale(srcW, srcH)
	dstW := int(float64(srcW) * userScale)
	dstH := int(float64(srcH) * userScale)
	if dstW <= 0 || dstH <= 0 {
		dstW = srcW
		dstH = srcH
	}

	useStretch := dstW > 0 && dstH > 0 && (dstW < srcW || dstH < srcH)
	capW := srcW
	capH := srcH
	if useStretch {
		capW = dstW
		capH = dstH
	}

	hdcScreen := createDisplayDC()
	fromCreateDC := hdcScreen != 0
	if hdcScreen == 0 {
		hdcScreen = getDC(0)
	}
	if hdcScreen == 0 {
		return nil, syscall.EINVAL
	}
	closeDC := func() {
		if hdcScreen == 0 {
			return
		}
		if fromCreateDC {
			deleteDC(hdcScreen)
		} else {
			releaseDC(0, hdcScreen)
		}
		hdcScreen = 0
	}
	defer closeDC()

	if capW <= 0 || capH <= 0 {
		return nil, syscall.EINVAL
	}

	captureWithDC := func() (*image.RGBA, time.Duration, time.Duration, time.Duration, error) {
		hdcMem, _, buf, stride, err := state.ensure(hdcScreen, capW, capH)
		if err != nil {
			return nil, 0, 0, 0, err
		}

		bitStart := time.Now()
		var captured bool
		if useStretch {
			captured = stretchBltCapture(hdcMem, hdcScreen, bounds, srcW, srcH, capW, capH)
		} else {
			captured = bitBltWithFallback(hdcMem, hdcScreen, bounds, capW, capH)
		}
		if !captured {
			state.reset()
			hdcMem, _, buf, stride, err = state.ensure(hdcScreen, capW, capH)
			if err != nil {
				return nil, 0, 0, 0, err
			}
			if useStretch {
				captured = stretchBltCapture(hdcMem, hdcScreen, bounds, srcW, srcH, capW, capH)
			} else {
				captured = bitBltWithFallback(hdcMem, hdcScreen, bounds, capW, capH)
			}
			if !captured {
				return nil, 0, 0, 0, syscall.EINVAL
			}
		}
		bitDur := time.Since(bitStart)
		cursorDrawn := false
		if useStretch {
			sx := float64(capW) / float64(srcW)
			sy := float64(capH) / float64(srcH)
			cursorDrawn = DrawCursorOnDCScaled(hdcMem, bounds, sx, sy)
		} else {
			cursorDrawn = DrawCursorOnDC(hdcMem, bounds)
		}

		if len(buf) == 0 {
			return nil, 0, 0, 0, syscall.EINVAL
		}

		dibDur := time.Duration(0)

		convStart := time.Now()
		swapRB(buf)
		img := &image.RGBA{Pix: buf, Stride: stride, Rect: image.Rect(0, 0, capW, capH)}
		convDur := time.Since(convStart)

		if !useStretch && !cursorDrawn {
			DrawCursorOnImage(img, bounds)
		}
		if dstW != capW || dstH != capH {
			img = resizeNearest(img, dstW, dstH)
		} else {
			// Detach from the reusable DIB buffer to avoid concurrent mutation during encode.
			stable := image.NewRGBA(img.Rect)
			copy(stable.Pix, img.Pix)
			img = stable
		}

		return img, bitDur, dibDur, convDur, nil
	}

	img, bitDur, dibDur, convDur, err := captureWithDC()
	if err != nil && fromCreateDC {
		closeDC()
		hdcScreen = getDC(0)
		fromCreateDC = false
		if hdcScreen == 0 {
			return nil, err
		}
		img, bitDur, dibDur, convDur, err = captureWithDC()
	}
	if err != nil {
		return nil, err
	}

	logCaptureTimings(bitDur, dibDur, convDur)
	return img, nil
}

func clampToVirtual(bounds image.Rectangle) image.Rectangle {
	vx := int(getSystemMetric(SM_XVIRTUALSCREEN))
	vy := int(getSystemMetric(SM_YVIRTUALSCREEN))
	vw := int(getSystemMetric(SM_CXVIRTUALSCREEN))
	vh := int(getSystemMetric(SM_CYVIRTUALSCREEN))
	if vw <= 0 || vh <= 0 {
		return bounds
	}
	virtual := image.Rect(vx, vy, vx+vw, vy+vh)
	inter := bounds.Intersect(virtual)
	if inter.Empty() {
		return bounds
	}
	return inter
}

func resolveBounds(mon monitorDesc) image.Rectangle {
	virtualW := int(getSystemMetric(SM_CXVIRTUALSCREEN))
	virtualH := int(getSystemMetric(SM_CYVIRTUALSCREEN))
	if virtualW > 0 && virtualH > 0 {
		return clampToVirtual(mon.rect)
	}
	return captureBounds(mon)
}

func captureBounds(mon monitorDesc) image.Rectangle {
	bounds := mon.rect
	if mon.physW > 0 && mon.physH > 0 {
		phys := image.Rect(mon.posX, mon.posY, mon.posX+mon.physW, mon.posY+mon.physH)
		if phys.Dx() > 0 && phys.Dy() > 0 {
			if mon.scale != 1.0 || phys.Dx() != bounds.Dx() || phys.Dy() != bounds.Dy() {
				bounds = phys
			}
		}
	}
	return bounds
}

func swapRB(pix []byte) {
	for i := 0; i+3 < len(pix); i += 4 {
		pix[i], pix[i+2] = pix[i+2], pix[i]
	}
}

func logCaptureTimings(bitDur, dibDur, convDur time.Duration) {
	captureCount.Add(1)
	bitbltNs.Add(bitDur.Nanoseconds())
	convertNs.Add(convDur.Nanoseconds())

	nowNs := time.Now().UnixNano()
	last := lastCaptureLogNs.Load()
	if last != 0 && time.Duration(nowNs-last) < 5*time.Second {
		return
	}
	if !lastCaptureLogNs.CompareAndSwap(last, nowNs) {
		return
	}
	frames := captureCount.Swap(0)
	if frames == 0 {
		return
	}
	avg := func(totalNs atomic.Int64) float64 {
		return float64(totalNs.Swap(0)) / 1e6 / float64(frames)
	}
	bitAvg := avg(bitbltNs)
	convAvg := avg(convertNs)
	log.Printf("capture: win bitblt avg bitblt=%.2fms convert=%.2fms frames=%d", bitAvg, convAvg, frames)
}

func resizeNearest(src *image.RGBA, w, h int) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	srcW := src.Bounds().Dx()
	srcH := src.Bounds().Dy()
	if srcW <= 0 || srcH <= 0 || w <= 0 || h <= 0 {
		return dst
	}
	xOff := make([]int, w)
	for x := 0; x < w; x++ {
		xOff[x] = (x * srcW / w) * 4
	}
	srcPix := src.Pix
	dstPix := dst.Pix
	srcStride := src.Stride
	dstStride := dst.Stride
	for y := 0; y < h; y++ {
		sp := (y * srcH / h) * srcStride
		dp := y * dstStride
		for x := 0; x < w; x++ {
			*(*uint32)(unsafe.Pointer(&dstPix[dp+x*4])) = *(*uint32)(unsafe.Pointer(&srcPix[sp+xOff[x]]))
		}
	}
	return dst
}

type capState struct {
	mu     sync.Mutex
	hdcMem uintptr
	hbmp   uintptr
	buf    []byte
	stride int
	w      int
	h      int
	bits   unsafe.Pointer
}

func (s *capState) ensure(hdcScreen uintptr, w, h int) (uintptr, uintptr, []byte, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.hdcMem == 0 {
		s.hdcMem = createCompatibleDC(hdcScreen)
		if s.hdcMem == 0 {
			return 0, 0, nil, 0, syscall.EINVAL
		}
	}

	if s.w != w || s.h != h || s.hbmp == 0 {
		bmi := bitmapInfo{
			bmiHeader: bitmapInfoHeader{
				biSize:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
				biWidth:       int32(w),
				biHeight:      -int32(h),
				biPlanes:      1,
				biBitCount:    32,
				biCompression: BI_RGB,
			},
		}
		var bits unsafe.Pointer
		newBmp := createDIBSection(s.hdcMem, &bmi, DIB_RGB_COLORS, &bits)
		if newBmp == 0 || bits == nil {
			return 0, 0, nil, 0, syscall.EINVAL
		}
		selectObject(s.hdcMem, newBmp)
		if s.hbmp != 0 {
			deleteObject(s.hbmp)
		}
		s.hbmp = newBmp
		s.w = w
		s.h = h
		s.stride = w * 4
		s.bits = bits
		s.buf = unsafe.Slice((*byte)(bits), s.stride*h)
	}

	return s.hdcMem, s.hbmp, s.buf, s.stride, nil
}

func (s *capState) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hbmp != 0 {
		deleteObject(s.hbmp)
		s.hbmp = 0
	}
	if s.hdcMem != 0 {
		deleteDC(s.hdcMem)
		s.hdcMem = 0
	}
	s.buf = nil
	s.stride = 0
	s.w = 0
	s.h = 0
	s.bits = nil
}

func captureScale() float64 {
	scaleOnce.Do(func() {
		s := 1.0
		if env := os.Getenv("OVERLORD_RD_SCALE"); env != "" {
			if v, err := strconv.ParseFloat(env, 64); err == nil && v > 0.2 && v <= 1.5 {
				s = v
			}
		}
		cachedScale = s
	})
	return cachedScale
}

func effectiveScale(srcW, srcH int) float64 {
	s := captureScale()
	maxH := int(maxResHeight.Load())
	if maxH == 0 {
		maxH = 1080
	} else if maxH < 0 {
		storeLastScale(s)
		return s
	}
	if srcH > maxH {
		resCap := float64(maxH) / float64(srcH)
		if resCap < s {
			s = resCap
		}
	}
	storeLastScale(s)
	return s
}

func storeLastScale(s float64) {
	lastCapScale.Store(math.Float64bits(s))
}

func SetMaxResolution(maxH int) {
	maxResHeight.Store(int64(maxH))
	log.Printf("capture: max resolution set to %d", maxH)
}

func BypassResolutionCap() (restore func()) {
	old := maxResHeight.Swap(-1)
	return func() { maxResHeight.Store(old) }
}

func EffectiveScaleForInput() float64 {
	bits := lastCapScale.Load()
	if bits == 0 {
		return 1.0
	}
	return math.Float64frombits(bits)
}
