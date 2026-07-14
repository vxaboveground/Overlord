//go:build windows && cgo

package qsvbridge

/*
#cgo CXXFLAGS: -std=c++17
#cgo LDFLAGS: -static -static-libgcc -static-libstdc++ -lole32 -ld3d11 -ldxgi
#include <stdlib.h>
#include "bridge_windows.h"
*/
import "C"

import "unsafe"

type Encoder struct{ handle C.overlord_qsv_encoder }
type Error struct{ Text string }

func (e *Error) Error() string { return e.Text }

func Probe() (bool, string) {
	b := make([]byte, 512)
	if C.overlord_qsv_probe((*C.char)(unsafe.Pointer(&b[0])), C.int(len(b))) == 0 {
		return false, message(b, "oneVPL unavailable")
	}
	return true, "Intel oneVPL H.264 hardware encoder available"
}

func Create(device unsafe.Pointer, inputWidth, inputHeight, encodeWidth, encodeHeight, fps int, format uint32, bitrate int) (*Encoder, error) {
	var h C.overlord_qsv_encoder
	b := make([]byte, 512)
	ok := C.overlord_qsv_create(device, C.int(inputWidth), C.int(inputHeight), C.int(encodeWidth), C.int(encodeHeight),
		C.int(fps), C.uint32_t(format), C.int(bitrate), &h, (*C.char)(unsafe.Pointer(&b[0])), C.int(len(b)))
	if ok == 0 || h == nil {
		return nil, &Error{Text: message(b, "oneVPL encoder creation failed")}
	}
	return &Encoder{handle: h}, nil
}

func (e *Encoder) Encode(texture unsafe.Pointer, forceIDR bool, output []byte) (int, int, error) {
	if e == nil || e.handle == nil {
		return 0, 0, &Error{Text: "oneVPL encoder is not initialized"}
	}
	b := make([]byte, 512)
	var size C.int
	var out *C.uint8_t
	if len(output) != 0 {
		out = (*C.uint8_t)(unsafe.Pointer(&output[0]))
	}
	force := C.int(0)
	if forceIDR {
		force = 1
	}
	r := C.overlord_qsv_encode(e.handle, texture, force, out, C.int(len(output)), &size, (*C.char)(unsafe.Pointer(&b[0])), C.int(len(b)))
	if r == 0 {
		return 0, int(size), &Error{Text: message(b, "oneVPL encode failed")}
	}
	return int(r), int(size), nil
}

func (e *Encoder) Close() {
	if e != nil && e.handle != nil {
		C.overlord_qsv_destroy(e.handle)
		e.handle = nil
	}
}
func message(b []byte, fallback string) string {
	for i, v := range b {
		if v == 0 {
			b = b[:i]
			break
		}
	}
	if len(b) == 0 {
		return fallback
	}
	return string(b)
}
