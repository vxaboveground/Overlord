//go:build linux || darwin || freebsd

package main

/*
#include <stdint.h>

typedef void (*host_callback_t)(uintptr_t ctx,
	const char* event, int eventLen,
	const char* payload, int payloadLen);

static void invoke_host_callback(uintptr_t fn, uintptr_t ctx,
	const char* ev, int evLen, const char* pl, int plLen) {
	((host_callback_t)fn)(ctx, ev, evLen, pl, plLen);
}
*/
import "C"

import "unsafe"

var (
	hostCallbackFn  C.uintptr_t
	hostCallbackCtx C.uintptr_t
)

func hostSendViaCallback(event string, payload []byte) {
	fn := hostCallbackFn
	if fn == 0 {
		return
	}
	evBytes := []byte(event)
	var evPtr, plPtr unsafe.Pointer
	if len(evBytes) > 0 {
		evPtr = unsafe.Pointer(&evBytes[0])
	}
	if len(payload) > 0 {
		plPtr = unsafe.Pointer(&payload[0])
	}
	C.invoke_host_callback(fn, hostCallbackCtx,
		(*C.char)(evPtr), C.int(len(evBytes)),
		(*C.char)(plPtr), C.int(len(payload)))
}

//export PluginOnLoad
func PluginOnLoad(hostInfo *C.char, hostInfoLen C.int, cb C.uintptr_t, ctx C.uintptr_t) C.int {
	hostCallbackFn = cb
	hostCallbackCtx = ctx
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
