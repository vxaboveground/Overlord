//go:build windows

package capture

import (
	"errors"
	"testing"
	"unsafe"
)

type fakeD3D11TextureBackend struct {
	name          string
	outputs       [][]byte
	errors        []error
	encodeCalls   int
	resetCalls    int
	keyframeCalls int
}

func (b *fakeD3D11TextureBackend) Name() string { return b.name }
func (b *fakeD3D11TextureBackend) Encode(h264D3D11TextureRequest) ([]byte, error) {
	index := b.encodeCalls
	b.encodeCalls++
	if index < len(b.errors) && b.errors[index] != nil {
		return nil, b.errors[index]
	}
	if index < len(b.outputs) {
		return b.outputs[index], nil
	}
	return []byte{byte(index + 1)}, nil
}
func (b *fakeD3D11TextureBackend) RequestKeyframe() { b.keyframeCalls++ }
func (b *fakeD3D11TextureBackend) Reset()           { b.resetCalls++ }

func TestD3D11TextureBackendSelectionAndFailover(t *testing.T) {
	first := &fakeD3D11TextureBackend{name: "first", errors: []error{errors.New("unsupported")}}
	second := &fakeD3D11TextureBackend{name: "second", outputs: [][]byte{{1, 2, 3}, {4, 5, 6}}}

	d3d11H264TextureRegistry.Lock()
	savedBackends := d3d11H264TextureRegistry.backends
	savedActive := d3d11H264TextureRegistry.active
	d3d11H264TextureRegistry.backends = []h264D3D11TextureBackend{first, second}
	d3d11H264TextureRegistry.active = nil
	d3d11H264TextureRegistry.Unlock()
	t.Cleanup(func() {
		d3d11H264TextureRegistry.Lock()
		d3d11H264TextureRegistry.backends = savedBackends
		d3d11H264TextureRegistry.active = savedActive
		d3d11H264TextureRegistry.Unlock()
	})

	device, texture := 1, 2
	req := h264D3D11TextureRequest{Device: unsafe.Pointer(&device), Texture: unsafe.Pointer(&texture)}
	out, provider, err := encodeH264D3D11Texture(req)
	if err != nil {
		t.Fatalf("first encode: %v", err)
	}
	if provider != "second" || len(out) != 3 {
		t.Fatalf("provider=%q out=%v", provider, out)
	}
	if first.resetCalls != 1 || second.encodeCalls != 1 {
		t.Fatalf("unexpected calls first.reset=%d second.encode=%d", first.resetCalls, second.encodeCalls)
	}

	_, provider, err = encodeH264D3D11Texture(req)
	if err != nil || provider != "second" {
		t.Fatalf("active backend reuse provider=%q err=%v", provider, err)
	}
	if first.encodeCalls != 1 || second.encodeCalls != 2 {
		t.Fatalf("active backend was not reused: first=%d second=%d", first.encodeCalls, second.encodeCalls)
	}

	requestH264D3D11TextureKeyframe()
	if second.keyframeCalls != 1 || first.keyframeCalls != 0 {
		t.Fatalf("keyframe routed incorrectly: first=%d second=%d", first.keyframeCalls, second.keyframeCalls)
	}
	resetH264D3D11TextureEncoder()
	if first.resetCalls != 2 || second.resetCalls != 1 {
		t.Fatalf("reset did not reach every backend: first=%d second=%d", first.resetCalls, second.resetCalls)
	}
}
