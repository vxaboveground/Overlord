//go:build windows

package capture

import (
	"bytes"
	"image/png"
	"testing"
)

func TestCursorMetadataDoesNotEnableFrameCompositing(t *testing.T) {
	before := cursorGeneration.Load()
	SetCursorCapture(true)
	t.Cleanup(func() { SetCursorCapture(false) })

	if !cursorMetadataEnabled.Load() {
		t.Fatal("cursor metadata should be enabled")
	}
	if cursorCaptureEnabled.Load() {
		t.Fatal("cursor frame compositing disables the direct capture path")
	}
	if got := cursorGeneration.Load(); got != before+1 {
		t.Fatalf("cursor metadata generation = %d, want %d", got, before+1)
	}
	state := DesktopCursorState(0, 1, 1)
	if !state.Enabled || state.Generation != before+1 {
		t.Fatalf("cursor state enabled=%v generation=%d, want enabled generation %d", state.Enabled, state.Generation, before+1)
	}

	SetCursorCapture(true)
	if got := cursorGeneration.Load(); got != before+2 {
		t.Fatalf("refresh generation = %d, want %d", got, before+2)
	}
	if cursorCaptureEnabled.Load() {
		t.Fatal("metadata refresh enabled frame compositing")
	}
}

func TestScaleCursorMetricFrom4KTo1080p(t *testing.T) {
	if got := scaleCursorMetric(64, 1920, 3840); got != 32 {
		t.Fatalf("scaled cursor width = %d, want 32", got)
	}
	if got := scaleCursorMetric(64, 1080, 2160); got != 32 {
		t.Fatalf("scaled cursor height = %d, want 32", got)
	}
	if got := scaleCursorMetric(1, 1920, 3840); got != 1 {
		t.Fatalf("non-zero cursor metric collapsed to %d", got)
	}
}

func TestReconstructCursorRGBA(t *testing.T) {
	black := []byte{
		0, 0, 0, 255,
		0, 0, 255, 255,
		255, 255, 255, 255,
	}
	white := []byte{
		255, 255, 255, 255,
		0, 0, 255, 255,
		0, 0, 0, 255,
	}
	img := reconstructCursorRGBA(black, white, 3, 1)

	if got := img.NRGBAAt(0, 0); got.A != 0 {
		t.Fatalf("transparent pixel alpha = %d, want 0", got.A)
	}
	if got := img.NRGBAAt(1, 0); got.R != 255 || got.G != 0 || got.B != 0 || got.A != 255 {
		t.Fatalf("opaque color pixel = %#v, want opaque red", got)
	}
	if got := img.NRGBAAt(2, 0); got.R != 255 || got.G != 255 || got.B != 255 || got.A != 255 {
		t.Fatalf("inverting monochrome pixel fallback = %#v, want opaque white", got)
	}
}

func TestExtractSystemCursorShape(t *testing.T) {
	const idcArrow = 32512
	loadCursorW := user32.NewProc("LoadCursorW")
	hCursor, _, callErr := loadCursorW.Call(0, idcArrow)
	if hCursor == 0 {
		t.Fatalf("LoadCursorW(IDC_ARROW): %v", callErr)
	}

	shape, err := extractCursorShape(hCursor)
	if err != nil {
		t.Fatalf("extract system arrow: %v", err)
	}
	if shape.width <= 0 || shape.height <= 0 {
		t.Fatalf("invalid extracted dimensions %dx%d", shape.width, shape.height)
	}
	if shape.hotspotX < 0 || shape.hotspotX >= shape.width || shape.hotspotY < 0 || shape.hotspotY >= shape.height {
		t.Fatalf("hotspot (%d,%d) outside %dx%d cursor", shape.hotspotX, shape.hotspotY, shape.width, shape.height)
	}
	config, err := png.DecodeConfig(bytes.NewReader(shape.image))
	if err != nil {
		t.Fatalf("decode extracted PNG: %v", err)
	}
	if config.Width != shape.width || config.Height != shape.height {
		t.Fatalf("PNG dimensions %dx%d, metadata %dx%d", config.Width, config.Height, shape.width, shape.height)
	}
}
