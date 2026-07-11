//go:build windows

package capture

import (
	"fmt"
	"strings"
	"sync"
	"unsafe"
)

type h264D3D11TextureRequest struct {
	Device       unsafe.Pointer
	Texture      unsafe.Pointer
	InputWidth   int
	InputHeight  int
	EncodeWidth  int
	EncodeHeight int
	FPS          int
	DXGIFormat   uint32
	ForceIDR     bool
}

type h264D3D11TextureBackend interface {
	Name() string
	Encode(h264D3D11TextureRequest) ([]byte, error)
	RequestKeyframe()
	Reset()
}

type nvencD3D11TextureBackend struct{}

func (nvencD3D11TextureBackend) Name() string { return "NVIDIA NVENC" }

func (nvencD3D11TextureBackend) Encode(req h264D3D11TextureRequest) ([]byte, error) {
	return encodeNativeH264D3D11Texture(req.Device, req.Texture, req.InputWidth, req.InputHeight,
		req.EncodeWidth, req.EncodeHeight, req.FPS, req.DXGIFormat, req.ForceIDR)
}

func (nvencD3D11TextureBackend) RequestKeyframe() {
	requestNativeH264D3D11TextureKeyframe()
}

func (nvencD3D11TextureBackend) Reset() {
	resetNativeH264D3D11TextureEncoder()
}

var d3d11H264TextureRegistry = struct {
	sync.Mutex
	backends []h264D3D11TextureBackend
	active   h264D3D11TextureBackend
}{
	backends: []h264D3D11TextureBackend{nvencD3D11TextureBackend{}},
}

func encodeH264D3D11Texture(req h264D3D11TextureRequest) ([]byte, string, error) {
	if req.Device == nil || req.Texture == nil {
		return nil, "", fmt.Errorf("nil D3D11 device or texture")
	}
	d3d11H264TextureRegistry.Lock()
	defer d3d11H264TextureRegistry.Unlock()

	failedActiveName := ""
	errorsByBackend := make([]string, 0, len(d3d11H264TextureRegistry.backends))
	if active := d3d11H264TextureRegistry.active; active != nil {
		out, err := active.Encode(req)
		if err == nil {
			return out, active.Name(), nil
		}
		active.Reset()
		failedActiveName = active.Name()
		errorsByBackend = append(errorsByBackend, active.Name()+": "+err.Error())
		d3d11H264TextureRegistry.active = nil
	}

	for _, backend := range d3d11H264TextureRegistry.backends {
		if backend == nil || (failedActiveName != "" && backend.Name() == failedActiveName) {
			continue
		}
		out, err := backend.Encode(req)
		if err == nil {
			d3d11H264TextureRegistry.active = backend
			return out, backend.Name(), nil
		}
		backend.Reset()
		errorsByBackend = append(errorsByBackend, backend.Name()+": "+err.Error())
	}
	if len(errorsByBackend) == 0 {
		return nil, "", fmt.Errorf("no D3D11 H.264 texture encoder backends registered")
	}
	return nil, "", fmt.Errorf("D3D11 H.264 texture encoders unavailable: %s", strings.Join(errorsByBackend, "; "))
}

func requestH264D3D11TextureKeyframe() {
	d3d11H264TextureRegistry.Lock()
	defer d3d11H264TextureRegistry.Unlock()
	if d3d11H264TextureRegistry.active != nil {
		d3d11H264TextureRegistry.active.RequestKeyframe()
		return
	}
	for _, backend := range d3d11H264TextureRegistry.backends {
		if backend != nil {
			backend.RequestKeyframe()
		}
	}
}

func resetH264D3D11TextureEncoder() {
	d3d11H264TextureRegistry.Lock()
	defer d3d11H264TextureRegistry.Unlock()
	for _, backend := range d3d11H264TextureRegistry.backends {
		if backend != nil {
			backend.Reset()
		}
	}
	d3d11H264TextureRegistry.active = nil
}
