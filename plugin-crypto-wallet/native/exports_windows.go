//go:build windows

package main

import "C"
import (
	"syscall"
	"unsafe"
)

var callbackPtr uintptr

func hostSendViaCallback(event string, payload []byte) {
	cb := callbackPtr
	if cb == 0 {
		return
	}
	eventBytes := []byte(event)
	var evPtr, plPtr uintptr
	evLen := uintptr(len(eventBytes))
	plLen := uintptr(len(payload))
	if len(eventBytes) > 0 {
		evPtr = uintptr(unsafe.Pointer(&eventBytes[0]))
	}
	if len(payload) > 0 {
		plPtr = uintptr(unsafe.Pointer(&payload[0]))
	}
	syscall.SyscallN(cb, evPtr, evLen, plPtr, plLen)
}

//export PluginSetCallback
func PluginSetCallback(cb C.ulonglong) {
	callbackPtr = uintptr(cb)
	setSend(hostSendViaCallback)
}

//export PluginOnLoad
func PluginOnLoad(hostInfo *C.char, hostInfoLen C.int, cb C.ulonglong) C.int {
	callbackPtr = uintptr(cb)
	setSend(hostSendViaCallback)

	data := C.GoBytes(unsafe.Pointer(hostInfo), hostInfoLen)
	if err := handleInit(data); err != nil {
		return 1
	}
	return 0
}

//export PluginOnEvent
func PluginOnEvent(event *C.char, eventLen C.int, payload *C.char, payloadLen C.int) C.int {
	ev := C.GoStringN(event, eventLen)
	var pl []byte
	if payloadLen > 0 {
		pl = C.GoBytes(unsafe.Pointer(payload), payloadLen)
	}
	if err := handleEvent(ev, pl); err != nil {
		return 1
	}
	return 0
}

//export PluginOnUnload
func PluginOnUnload() {
	handleUnload()
}

func main() {}
