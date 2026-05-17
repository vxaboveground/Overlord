//go:build windows && (amd64 || arm64)

package handlers

import (
	"syscall"
	"unsafe"
)

func callGetImage(getImageFn, this uintptr, cx, cy int32, flags uint32, hBitmapOut *uintptr) uintptr {
	sizeWord := uintptr(uint64(uint32(cx)) | (uint64(uint32(cy)) << 32))
	hr, _, _ := syscall.SyscallN(
		getImageFn,
		this,
		sizeWord,
		uintptr(flags),
		uintptr(unsafe.Pointer(hBitmapOut)),
	)
	return hr
}

func callRelease(releaseFn, this uintptr) {
	syscall.SyscallN(releaseFn, this)
}
