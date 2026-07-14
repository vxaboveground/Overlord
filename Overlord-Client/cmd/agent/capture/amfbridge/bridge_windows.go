//go:build windows && cgo

package amfbridge

/*
#cgo CXXFLAGS: -std=c++17
#cgo LDFLAGS: -static -static-libgcc -static-libstdc++ -lole32
#include <stdlib.h>
#include "bridge_windows.h"
*/
import "C"

import (
	"unsafe"
)

type Encoder struct{ handle C.overlord_amf_encoder }

func Probe() (bool, string) {
	errText := make([]byte, 512)
	ok := C.overlord_amf_probe((*C.char)(unsafe.Pointer(&errText[0])), C.int(len(errText)))
	if ok == 0 {
		return false, message(errText, "AMF unavailable")
	}
	return true, "AMF runtime available"
}

func Create(device unsafe.Pointer, inputWidth, inputHeight, encodeWidth, encodeHeight, fps int, dxgiFormat uint32, bitrate int) (*Encoder, error) {
	var handle C.overlord_amf_encoder
	errText := make([]byte, 512)
	ok := C.overlord_amf_create(device, C.int(inputWidth), C.int(inputHeight), C.int(encodeWidth), C.int(encodeHeight),
		C.int(fps), C.uint32_t(dxgiFormat), C.int(bitrate), &handle,
		(*C.char)(unsafe.Pointer(&errText[0])), C.int(len(errText)))
	if ok == 0 || handle == nil {
		return nil, &Error{Text: message(errText, "AMF encoder creation failed")}
	}
	return &Encoder{handle: handle}, nil
}

func (e *Encoder) Encode(texture unsafe.Pointer, forceIDR bool, output []byte) (result int, size int, err error) {
	if e == nil || e.handle == nil {
		return 0, 0, &Error{Text: "AMF encoder is not initialized"}
	}
	errText := make([]byte, 512)
	var outputSize C.int
	var outputPtr *C.uint8_t
	if len(output) > 0 {
		outputPtr = (*C.uint8_t)(unsafe.Pointer(&output[0]))
	}
	force := C.int(0)
	if forceIDR {
		force = 1
	}
	r := C.overlord_amf_encode(e.handle, texture, force, outputPtr, C.int(len(output)), &outputSize,
		(*C.char)(unsafe.Pointer(&errText[0])), C.int(len(errText)))
	if r == 0 {
		return 0, int(outputSize), &Error{Text: message(errText, "AMF encode failed")}
	}
	return int(r), int(outputSize), nil
}

func (e *Encoder) Close() {
	if e != nil && e.handle != nil {
		C.overlord_amf_destroy(e.handle)
		e.handle = nil
	}
}

type Error struct{ Text string }

func (e *Error) Error() string { return e.Text }

func message(value []byte, fallback string) string {
	for i, b := range value {
		if b == 0 {
			value = value[:i]
			break
		}
	}
	if len(value) == 0 {
		return fallback
	}
	return string(value)
}
