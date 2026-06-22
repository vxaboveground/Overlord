package main

import "unsafe"

//go:wasmimport env overlord_emit
func overlordEmit(eventPtr, eventLen, payloadPtr, payloadLen uint32) int32

//go:wasmimport env overlord_host_info
func overlordHostInfo(outPtr, outLen uint32) int32

var heap = make([]byte, 64*1024)
var heapOffset uint32 = 8

var hostInfo [1024]byte
var hostInfoLen uint32

//go:export overlord_alloc
func overlordAlloc(size uint32) uint32 {
	if size == 0 {
		size = 1
	}
	ptr := (heapOffset + 7) &^ 7
	next := ptr + size
	if next >= uint32(len(heap)) {
		return 0
	}
	heapOffset = next
	return uint32(uintptr(unsafe.Pointer(&heap[ptr])))
}

//go:export overlord_free
func overlordFree(ptr, size uint32) {
	_, _ = ptr, size
}

//go:export overlord_on_load
func overlordOnLoad(hostPtr, hostLen uint32) int32 {
	n := hostLen
	if n > uint32(len(hostInfo)) {
		n = uint32(len(hostInfo))
	}
	copy(hostInfo[:n], bytesAt(hostPtr, n))
	hostInfoLen = n
	emit("ready", hostInfo[:hostInfoLen])
	return 0
}

//go:export overlord_on_event
func overlordOnEvent(eventPtr, eventLen, payloadPtr, payloadLen uint32) int32 {
	_, _ = payloadPtr, payloadLen
	event := string(bytesAt(eventPtr, eventLen))
	if event != "query_host" {
		return 0
	}

	var buf [1024]byte
	n := overlordHostInfo(uint32(uintptr(unsafe.Pointer(&buf[0]))), uint32(len(buf)))
	if n < 0 {
		emitString("host_info", `{"error":"host info buffer too small"}`)
		return 0
	}
	emit("host_info", buf[:uint32(n)])
	return 0
}

//go:export overlord_on_unload
func overlordOnUnload() {}

func emitString(event string, payload string) {
	emit(event, []byte(payload))
}

func emit(event string, payload []byte) {
	eventBytes := []byte(event)
	var eventPtr uint32
	var payloadPtr uint32
	if len(eventBytes) > 0 {
		eventPtr = uint32(uintptr(unsafe.Pointer(&eventBytes[0])))
	}
	if len(payload) > 0 {
		payloadPtr = uint32(uintptr(unsafe.Pointer(&payload[0])))
	}
	overlordEmit(eventPtr, uint32(len(eventBytes)), payloadPtr, uint32(len(payload)))
}

func bytesAt(ptr, length uint32) []byte {
	if length == 0 {
		return nil
	}
	return unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), length)
}

func main() {}
