//go:build windows

package capture

import (
	"errors"
	"image"
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
	savedFailures := d3d11H264TextureRegistry.failures
	d3d11H264TextureRegistry.backends = []h264D3D11TextureBackend{first, second}
	d3d11H264TextureRegistry.active = nil
	d3d11H264TextureRegistry.failures = make(map[d3d11H264FailureKey]d3d11H264Failure)
	d3d11H264TextureRegistry.Unlock()
	t.Cleanup(func() {
		d3d11H264TextureRegistry.Lock()
		d3d11H264TextureRegistry.backends = savedBackends
		d3d11H264TextureRegistry.active = savedActive
		d3d11H264TextureRegistry.failures = savedFailures
		d3d11H264TextureRegistry.Unlock()
	})

	device, texture := 1, 2
	req := h264D3D11TextureRequest{Device: unsafe.Pointer(&device), Texture: unsafe.Pointer(&texture)}
	out, provider, err := encodeH264D3D11Texture("desktop", req)
	if err != nil {
		t.Fatalf("first encode: %v", err)
	}
	if provider != "second" || len(out) != 3 {
		t.Fatalf("provider=%q out=%v", provider, out)
	}
	if first.resetCalls != 1 || second.encodeCalls != 1 {
		t.Fatalf("unexpected calls first.reset=%d second.encode=%d", first.resetCalls, second.encodeCalls)
	}

	_, provider, err = encodeH264D3D11Texture("desktop", req)
	if err != nil || provider != "second" {
		t.Fatalf("active backend reuse provider=%q err=%v", provider, err)
	}
	if first.encodeCalls != 1 || second.encodeCalls != 2 {
		t.Fatalf("active backend was not reused: first=%d second=%d", first.encodeCalls, second.encodeCalls)
	}

	requestH264D3D11TextureKeyframe("desktop")
	if second.keyframeCalls != 1 || first.keyframeCalls != 0 {
		t.Fatalf("keyframe routed incorrectly: first=%d second=%d", first.keyframeCalls, second.keyframeCalls)
	}
	resetH264D3D11TextureEncoder("desktop")
	if first.resetCalls != 2 || second.resetCalls != 1 {
		t.Fatalf("reset did not reach every backend: first=%d second=%d", first.resetCalls, second.resetCalls)
	}
}

func TestD3D11TextureBackendFailuresUseCooldown(t *testing.T) {
	first := &fakeD3D11TextureBackend{name: "first", errors: []error{errors.New("unsupported")}}
	second := &fakeD3D11TextureBackend{name: "second", errors: []error{errors.New("also unsupported")}}

	d3d11H264TextureRegistry.Lock()
	savedBackends := d3d11H264TextureRegistry.backends
	savedActive := d3d11H264TextureRegistry.active
	savedFailures := d3d11H264TextureRegistry.failures
	d3d11H264TextureRegistry.backends = []h264D3D11TextureBackend{first, second}
	d3d11H264TextureRegistry.active = nil
	d3d11H264TextureRegistry.failures = make(map[d3d11H264FailureKey]d3d11H264Failure)
	d3d11H264TextureRegistry.Unlock()
	t.Cleanup(func() {
		d3d11H264TextureRegistry.Lock()
		d3d11H264TextureRegistry.backends = savedBackends
		d3d11H264TextureRegistry.active = savedActive
		d3d11H264TextureRegistry.failures = savedFailures
		d3d11H264TextureRegistry.Unlock()
	})

	device, texture := 1, 2
	req := h264D3D11TextureRequest{Device: unsafe.Pointer(&device), Texture: unsafe.Pointer(&texture), EncodeWidth: 2560, EncodeHeight: 1440, FPS: 240}
	if _, _, err := encodeH264D3D11Texture("desktop", req); err == nil {
		t.Fatal("expected initial profile failure")
	}
	if _, _, err := encodeH264D3D11Texture("desktop", req); err == nil {
		t.Fatal("expected cached profile failure")
	}
	if first.encodeCalls != 1 || second.encodeCalls != 1 {
		t.Fatalf("failed profile was retried during cooldown: first=%d second=%d", first.encodeCalls, second.encodeCalls)
	}
}

type fakeH264FrameEncoder struct {
	output     []byte
	err        error
	encodeCall int
	closed     bool
}

func (e *fakeH264FrameEncoder) Encode(*image.RGBA) ([]byte, error) {
	e.encodeCall++
	return e.output, e.err
}

func (e *fakeH264FrameEncoder) Close() {
	e.closed = true
}

func (e *fakeH264FrameEncoder) Matches(_, _, _ int) bool {
	return true
}

func TestH264RuntimeFailureFallsBackPerStream(t *testing.T) {
	primary := &fakeH264FrameEncoder{err: errors.New("NVENC session failed")}
	software := &fakeH264FrameEncoder{output: []byte{7, 8, 9}}
	var slot h264FrameEncoder = primary
	factoryCalls := 0
	factory := func(width, height, fps int) (h264FrameEncoder, error) {
		factoryCalls++
		if width != 64 || height != 32 || fps != 47 {
			t.Fatalf("fallback config = %dx%d@%d, want 64x32@47", width, height, fps)
		}
		return software, nil
	}

	out, err := encodeH264FrameWithRuntimeFallback(
		&slot,
		"backstage",
		image.NewRGBA(image.Rect(0, 0, 64, 32)),
		47,
		factory,
	)
	if err != nil {
		t.Fatalf("runtime fallback failed: %v", err)
	}
	if factoryCalls != 1 || primary.encodeCall != 1 || !primary.closed {
		t.Fatalf("primary cleanup/fallback calls = factory:%d encode:%d closed:%v", factoryCalls, primary.encodeCall, primary.closed)
	}
	if slot != software || software.encodeCall != 1 {
		t.Fatalf("software encoder was not retained after fallback")
	}
	if len(out) != 3 || out[0] != 7 {
		t.Fatalf("fallback output = %v", out)
	}
}

func TestH264TargetFPSIsIndependentPerStream(t *testing.T) {
	SetDesktopH264TargetFPS(120)
	SetBackstageH264TargetFPS(37)
	SetWebcamH264TargetFPS(24)

	if got := activeH264FPS(); got != 120 {
		t.Fatalf("desktop fps = %d, want 120", got)
	}
	if got := activeH264FPSForStream("backstage"); got != 37 {
		t.Fatalf("backstage fps = %d, want 37", got)
	}
	if got := activeH264FPSForStream("webcam"); got != 24 {
		t.Fatalf("webcam fps = %d, want 24", got)
	}
}

func TestD3D11TextureEncodersAreIsolatedByStream(t *testing.T) {
	desktopBackend := &fakeD3D11TextureBackend{name: "desktop", outputs: [][]byte{{1}, {2}}}
	backstageBackend := &fakeD3D11TextureBackend{name: "backstage", outputs: [][]byte{{3}}}
	savedDesktop := d3d11H264TextureRegistry
	savedBackstage := backstageD3D11H264TextureRegistry
	d3d11H264TextureRegistry = &h264D3D11TextureRegistry{
		backends: []h264D3D11TextureBackend{desktopBackend},
		failures: make(map[d3d11H264FailureKey]d3d11H264Failure),
	}
	backstageD3D11H264TextureRegistry = &h264D3D11TextureRegistry{
		backends: []h264D3D11TextureBackend{backstageBackend},
		failures: make(map[d3d11H264FailureKey]d3d11H264Failure),
	}
	t.Cleanup(func() {
		d3d11H264TextureRegistry = savedDesktop
		backstageD3D11H264TextureRegistry = savedBackstage
	})

	desktopDevice, desktopTexture := 1, 2
	backstageDevice, backstageTexture := 3, 4
	desktopReq := h264D3D11TextureRequest{
		Device: unsafe.Pointer(&desktopDevice), Texture: unsafe.Pointer(&desktopTexture),
		EncodeWidth: 1920, EncodeHeight: 1080, FPS: 60,
	}
	backstageReq := h264D3D11TextureRequest{
		Device: unsafe.Pointer(&backstageDevice), Texture: unsafe.Pointer(&backstageTexture),
		EncodeWidth: 1280, EncodeHeight: 720, FPS: 30,
	}

	if _, _, err := encodeH264D3D11Texture("desktop", desktopReq); err != nil {
		t.Fatalf("desktop encode: %v", err)
	}
	if _, _, err := encodeH264D3D11Texture("backstage", backstageReq); err != nil {
		t.Fatalf("backstage encode: %v", err)
	}
	if _, _, err := encodeH264D3D11Texture("desktop", desktopReq); err != nil {
		t.Fatalf("second desktop encode: %v", err)
	}
	if desktopBackend.encodeCalls != 2 || backstageBackend.encodeCalls != 1 {
		t.Fatalf("stream calls crossed: desktop=%d backstage=%d", desktopBackend.encodeCalls, backstageBackend.encodeCalls)
	}
	if desktopBackend.resetCalls != 0 || backstageBackend.resetCalls != 0 {
		t.Fatalf("one stream reset the other: desktop=%d backstage=%d", desktopBackend.resetCalls, backstageBackend.resetCalls)
	}
}
