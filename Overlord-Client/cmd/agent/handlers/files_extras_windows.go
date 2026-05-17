//go:build windows
// +build windows

package handlers

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"log"
	"runtime"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	feShell32                    = windows.NewLazySystemDLL("shell32.dll")
	feOle32                      = windows.NewLazySystemDLL("ole32.dll")
	pSHGetFileInfoW              = feShell32.NewProc("SHGetFileInfoW")
	pSHCreateItemFromParsingName = feShell32.NewProc("SHCreateItemFromParsingName")
	pCoInitializeEx              = feOle32.NewProc("CoInitializeEx")
	pCoUninitialize              = feOle32.NewProc("CoUninitialize")
)

const (
	shgfiIcon               = 0x000000100
	shgfiSmallIcon          = 0x000000001
	shgfiLargeIcon          = 0x000000000
	shgfiUseFileAttributes  = 0x000000010
	fileAttributeNormal     = 0x00000080
	coinitApartmentThreaded = 0x2
	coinitDisableOLE1DDE    = 0x4

	siigbfResizeToFit   = 0x00
	siigbfBiggerSizeOk  = 0x01
	siigbfMemoryOnly    = 0x02
	siigbfIconOnly      = 0x04
	siigbfThumbnailOnly = 0x08
	siigbfInCacheOnly   = 0x10
)

type shFileInfoW struct {
	HIcon         uintptr
	IIcon         int32
	DwAttributes  uint32
	SzDisplayName [260]uint16
	SzTypeName    [80]uint16
}

var iidIShellItemImageFactory = windows.GUID{
	Data1: 0xbcc18b79, Data2: 0xba16, Data3: 0x442f,
	Data4: [8]byte{0x80, 0xc4, 0x8a, 0x59, 0xc3, 0x0c, 0x46, 0x3b},
}

type iShellItemImageFactoryVtbl struct {
	QueryInterface uintptr
	AddRef         uintptr
	Release        uintptr
	GetImage       uintptr
}

type iShellItemImageFactory struct {
	Vtbl *iShellItemImageFactoryVtbl
}

type comJob struct {
	fn   func()
	done chan struct{}
}

var (
	comStartOnce sync.Once
	comQueue     chan comJob
)

func runOnCOMThread(fn func()) {
	comStartOnce.Do(func() {
		comQueue = make(chan comJob, 256)
		go func() {
			runtime.LockOSThread()
			defer runtime.UnlockOSThread()
			pCoInitializeEx.Call(0, uintptr(coinitApartmentThreaded|coinitDisableOLE1DDE))
			defer pCoUninitialize.Call()
			for job := range comQueue {
				func() {
					defer func() {
						if r := recover(); r != nil {
							log.Printf("com worker: recovered panic: %v", r)
						}
					}()
					job.fn()
				}()
				close(job.done)
			}
		}()
	})
	done := make(chan struct{})
	comQueue <- comJob{fn: fn, done: done}
	<-done
}

func hBitmapToRGBA(hBitmap uintptr) *image.RGBA {
	var bm bitmapObj
	pGetObjectW.Call(hBitmap, unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm)))
	if bm.BmWidth <= 0 || bm.BmHeight <= 0 {
		return nil
	}
	w := int(bm.BmWidth)
	h := int(bm.BmHeight)

	hdc, _, _ := pCreateCompatibleDC.Call(0)
	if hdc == 0 {
		return nil
	}
	defer pDeleteDC.Call(hdc)

	bih := bitmapInfoHeader{
		BiSize:     uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		BiWidth:    int32(w),
		BiHeight:   -int32(h),
		BiPlanes:   1,
		BiBitCount: 32,
	}
	pixels := make([]byte, w*h*4)
	pGetDIBits.Call(hdc, hBitmap, 0, uintptr(h),
		uintptr(unsafe.Pointer(&pixels[0])),
		uintptr(unsafe.Pointer(&bih)),
		0,
	)

	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			off := (y*w + x) * 4
			img.SetRGBA(x, y, color.RGBA{
				R: pixels[off+2],
				G: pixels[off+1],
				B: pixels[off+0],
				A: pixels[off+3],
			})
		}
	}
	return img
}

func extractFileIconPNG(targetPath, ext string) ([]byte, error) {
	var queryPath string
	flags := uint32(shgfiIcon | shgfiLargeIcon)
	if targetPath != "" {
		queryPath = targetPath
	} else if ext != "" {
		queryPath = "x." + strings.TrimPrefix(strings.ToLower(ext), ".")
		flags |= shgfiUseFileAttributes
	} else {
		return nil, fmt.Errorf("path or ext required")
	}

	pathPtr, err := windows.UTF16PtrFromString(queryPath)
	if err != nil {
		return nil, err
	}

	var out []byte
	var outErr error
	runOnCOMThread(func() {
		var sfi shFileInfoW
		ret, _, _ := pSHGetFileInfoW.Call(
			uintptr(unsafe.Pointer(pathPtr)),
			uintptr(fileAttributeNormal),
			uintptr(unsafe.Pointer(&sfi)),
			unsafe.Sizeof(sfi),
			uintptr(flags),
		)
		if ret == 0 || sfi.HIcon == 0 {
			outErr = fmt.Errorf("SHGetFileInfo failed")
			return
		}
		defer pDestroyIcon.Call(sfi.HIcon)

		var ii iconInfo
		r, _, _ := pGetIconInfo.Call(sfi.HIcon, uintptr(unsafe.Pointer(&ii)))
		if r == 0 {
			outErr = fmt.Errorf("GetIconInfo failed")
			return
		}
		if ii.HbmMask != 0 {
			defer pDeleteObject.Call(uintptr(ii.HbmMask))
		}
		if ii.HbmColor == 0 {
			outErr = fmt.Errorf("no color bitmap")
			return
		}
		defer pDeleteObject.Call(uintptr(ii.HbmColor))

		img := hBitmapToRGBA(uintptr(ii.HbmColor))
		if img == nil {
			outErr = fmt.Errorf("bitmap conversion failed")
			return
		}

		var buf bytes.Buffer
		if err := png.Encode(&buf, img); err != nil {
			outErr = err
			return
		}
		out = buf.Bytes()
	})
	return out, outErr
}

func extractFileThumbnailJPEG(path string, edge int) ([]byte, int, int, error) {
	if edge <= 0 {
		edge = 128
	}
	pathPtr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, 0, 0, err
	}

	var out []byte
	var outW, outH int
	var outErr error
	runOnCOMThread(func() {
		var itemPtr uintptr
		hr, _, _ := pSHCreateItemFromParsingName.Call(
			uintptr(unsafe.Pointer(pathPtr)),
			0,
			uintptr(unsafe.Pointer(&iidIShellItemImageFactory)),
			uintptr(unsafe.Pointer(&itemPtr)),
		)
		if hr != 0 || itemPtr == 0 {
			outErr = fmt.Errorf("SHCreateItemFromParsingName failed: 0x%x", hr)
			return
		}
		factory := (*iShellItemImageFactory)(unsafe.Pointer(itemPtr))
		defer callRelease(factory.Vtbl.Release, itemPtr)

		flags := uint32(siigbfThumbnailOnly | siigbfBiggerSizeOk)
		var hBitmap uintptr
		hr2 := callGetImage(factory.Vtbl.GetImage, itemPtr, int32(edge), int32(edge), flags, &hBitmap)
		if hr2 != 0 || hBitmap == 0 {
			outErr = fmt.Errorf("GetImage failed: 0x%x", hr2)
			return
		}
		defer pDeleteObject.Call(hBitmap)

		img := hBitmapToRGBA(hBitmap)
		if img == nil {
			outErr = fmt.Errorf("bitmap conversion failed")
			return
		}

		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 80}); err != nil {
			outErr = err
			return
		}
		out = buf.Bytes()
		outW = img.Bounds().Dx()
		outH = img.Bounds().Dy()
	})
	return out, outW, outH, outErr
}
