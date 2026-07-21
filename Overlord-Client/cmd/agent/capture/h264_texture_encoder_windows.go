//go:build windows

package capture

import (
	"fmt"
	"strings"
	"sync"
	"time"
	"unsafe"
)

const d3d11H264FailureCooldown = 30 * time.Second

type d3d11H264FailureKey struct {
	backend                                                 string
	device                                                  uintptr
	inputWidth, inputHeight, encodeWidth, encodeHeight, fps int
	dxgiFormat                                              uint32
}

type d3d11H264Failure struct {
	until time.Time
	err   string
}

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

type nvencD3D11TextureBackend struct {
	stream string
}

func (*nvencD3D11TextureBackend) Name() string { return "NVIDIA NVENC" }

func (b *nvencD3D11TextureBackend) Encode(req h264D3D11TextureRequest) ([]byte, error) {
	return encodeNativeH264D3D11Texture(b.stream, req.Device, req.Texture, req.InputWidth, req.InputHeight,
		req.EncodeWidth, req.EncodeHeight, req.FPS, req.DXGIFormat, req.ForceIDR)
}

func (b *nvencD3D11TextureBackend) RequestKeyframe() {
	requestNativeH264D3D11TextureKeyframe(b.stream)
}

func (b *nvencD3D11TextureBackend) Reset() {
	resetNativeH264D3D11TextureEncoder(b.stream)
}

type h264D3D11TextureRegistry struct {
	sync.Mutex
	backends []h264D3D11TextureBackend
	active   h264D3D11TextureBackend
	failures map[d3d11H264FailureKey]d3d11H264Failure
}

func newH264D3D11TextureRegistry(stream string) *h264D3D11TextureRegistry {
	registry := &h264D3D11TextureRegistry{
		backends: []h264D3D11TextureBackend{&nvencD3D11TextureBackend{stream: stream}},
		failures: make(map[d3d11H264FailureKey]d3d11H264Failure),
	}
	if backend := newQSVD3D11TextureBackend(); backend != nil {
		registry.backends = append(registry.backends, backend)
	}
	if backend := newAMFD3D11TextureBackend(); backend != nil {
		registry.backends = append(registry.backends, backend)
	}
	return registry
}

var (
	d3d11H264TextureRegistry          = newH264D3D11TextureRegistry("desktop")
	backstageD3D11H264TextureRegistry = newH264D3D11TextureRegistry("backstage")
)

func h264D3D11Registry(stream string) *h264D3D11TextureRegistry {
	if stream == "backstage" {
		return backstageD3D11H264TextureRegistry
	}
	return d3d11H264TextureRegistry
}

func encodeH264D3D11Texture(stream string, req h264D3D11TextureRequest) ([]byte, string, error) {
	if req.Device == nil || req.Texture == nil {
		return nil, "", fmt.Errorf("nil D3D11 device or texture")
	}
	registry := h264D3D11Registry(stream)
	registry.Lock()
	defer registry.Unlock()

	failedActiveName := ""
	errorsByBackend := make([]string, 0, len(registry.backends))
	if active := registry.active; active != nil {
		key := d3d11H264FailureKeyFor(active.Name(), req)
		if failure, failed := registry.activeFailure(key, time.Now()); !failed {
			out, err := active.Encode(req)
			if err == nil {
				delete(registry.failures, key)
				return out, active.Name(), nil
			}
			registry.rememberFailure(key, err)
			active.Reset()
			failedActiveName = active.Name()
			errorsByBackend = append(errorsByBackend, active.Name()+": "+err.Error())
			registry.active = nil
		} else {
			errorsByBackend = append(errorsByBackend, active.Name()+": "+failure.err+" (cooldown)")
			active.Reset()
			failedActiveName = active.Name()
			registry.active = nil
		}
	}

	now := time.Now()
	for _, backend := range registry.backends {
		if backend == nil || (failedActiveName != "" && backend.Name() == failedActiveName) {
			continue
		}
		key := d3d11H264FailureKeyFor(backend.Name(), req)
		if failure, failed := registry.activeFailure(key, now); failed {
			errorsByBackend = append(errorsByBackend, backend.Name()+": "+failure.err+" (cooldown)")
			continue
		}
		out, err := backend.Encode(req)
		if err == nil {
			delete(registry.failures, key)
			registry.active = backend
			return out, backend.Name(), nil
		}
		backend.Reset()
		registry.rememberFailure(key, err)
		errorsByBackend = append(errorsByBackend, backend.Name()+": "+err.Error())
	}
	if len(errorsByBackend) == 0 {
		return nil, "", fmt.Errorf("no D3D11 H.264 texture encoder backends registered")
	}
	return nil, "", fmt.Errorf("D3D11 H.264 texture encoders unavailable: %s", strings.Join(errorsByBackend, "; "))
}

func d3d11H264FailureKeyFor(backend string, req h264D3D11TextureRequest) d3d11H264FailureKey {
	return d3d11H264FailureKey{
		backend: backend, device: uintptr(req.Device), inputWidth: req.InputWidth, inputHeight: req.InputHeight,
		encodeWidth: req.EncodeWidth, encodeHeight: req.EncodeHeight, fps: req.FPS, dxgiFormat: req.DXGIFormat,
	}
}

func (r *h264D3D11TextureRegistry) activeFailure(key d3d11H264FailureKey, now time.Time) (d3d11H264Failure, bool) {
	failure, ok := r.failures[key]
	if !ok {
		return d3d11H264Failure{}, false
	}
	if !now.Before(failure.until) {
		delete(r.failures, key)
		return d3d11H264Failure{}, false
	}
	return failure, true
}

func (r *h264D3D11TextureRegistry) rememberFailure(key d3d11H264FailureKey, err error) {
	if len(r.failures) > 128 {
		now := time.Now()
		for existingKey, failure := range r.failures {
			if !now.Before(failure.until) {
				delete(r.failures, existingKey)
			}
		}
	}
	r.failures[key] = d3d11H264Failure{until: time.Now().Add(d3d11H264FailureCooldown), err: err.Error()}
}

func requestH264D3D11TextureKeyframe(stream string) {
	registry := h264D3D11Registry(stream)
	registry.Lock()
	defer registry.Unlock()
	if registry.active != nil {
		registry.active.RequestKeyframe()
		return
	}
	for _, backend := range registry.backends {
		if backend != nil {
			backend.RequestKeyframe()
		}
	}
}

func resetH264D3D11TextureEncoder(stream string) {
	registry := h264D3D11Registry(stream)
	registry.Lock()
	defer registry.Unlock()
	for _, backend := range registry.backends {
		if backend != nil {
			backend.Reset()
		}
	}
	registry.active = nil
}

func resetAllH264D3D11TextureEncoders() {
	resetH264D3D11TextureEncoder("desktop")
	resetH264D3D11TextureEncoder("backstage")
}
