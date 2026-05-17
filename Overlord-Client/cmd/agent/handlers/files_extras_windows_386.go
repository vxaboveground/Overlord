//go:build windows && 386

package handlers

import (
	"syscall"
	"unsafe"
)

func callGetImage(getImageFn, this uintptr, cx, cy int32, flags uint32, hBitmapOut *uintptr) uintptr {
	hr, _, _ := syscall.SyscallN(
		getImageFn,
		this,
		uintptr(uint32(cx)),
		uintptr(uint32(cy)),
		uintptr(flags),
		uintptr(unsafe.Pointer(hBitmapOut)),
	)
	return hr
}

func callRelease(releaseFn, this uintptr) {
	syscall.SyscallN(releaseFn, this)
}
