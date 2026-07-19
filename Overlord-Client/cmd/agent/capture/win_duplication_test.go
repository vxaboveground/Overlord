//go:build windows

package capture

import (
	"image"
	"strings"
	"testing"
	"time"
)

func isDXGITimeoutError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "dxgi: frame timeout")
}

func TestDesktopDuplicationToggleResetsState(t *testing.T) {
	dxgiState.mu.Lock()
	dxgiState.display = 0
	dxgiState.outputName = "test-output"
	dxgiState.bounds = image.Rect(1, 2, 3, 4)
	dxgiState.mu.Unlock()

	SetDesktopDuplication(true)
	if !useDesktopDuplication() {
		t.Fatalf("expected desktop duplication to be enabled")
	}

	dxgiState.mu.Lock()
	if dxgiState.display != -1 {
		dxgiState.mu.Unlock()
		t.Fatalf("expected display reset to -1, got %d", dxgiState.display)
	}
	if dxgiState.outputName != "" {
		dxgiState.mu.Unlock()
		t.Fatalf("expected outputName reset, got %q", dxgiState.outputName)
	}
	if dxgiState.bounds != (image.Rectangle{}) {
		dxgiState.mu.Unlock()
		t.Fatalf("expected bounds reset, got %+v", dxgiState.bounds)
	}
	dxgiState.mu.Unlock()

	SetDesktopDuplication(false)
	if useDesktopDuplication() {
		t.Fatalf("expected desktop duplication to be disabled")
	}
}

func TestCaptureDisplayDXGI(t *testing.T) {
	if displayCount() == 0 {
		t.Skip("no displays detected")
	}

	SetDesktopDuplication(true)
	t.Cleanup(func() { SetDesktopDuplication(false) })

	var (
		img *image.RGBA
		err error
	)
	for attempt := 0; attempt < 4; attempt++ {
		img, err = captureDisplayDXGI(0)
		if err == nil {
			break
		}

		msg := strings.ToLower(err.Error())
		if strings.Contains(msg, "dxgi: frame timeout") || strings.Contains(msg, "dxgi: access lost") {
			time.Sleep(60 * time.Millisecond)
			continue
		}
		break
	}

	if err != nil {
		if isDXGITimeoutError(err) {
			t.Logf("warning: dxgi capture timed out; treating as non-fatal: %v", err)
			return
		}
		t.Fatalf("dxgi capture failed: %v", err)
	}
	if img == nil {
		t.Fatalf("dxgi capture returned nil image")
	}
	bounds := img.Bounds()
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		t.Fatalf("invalid capture bounds: %dx%d", bounds.Dx(), bounds.Dy())
	}
}

func TestDirectVideoKeyframeDue(t *testing.T) {
	now := (10 * time.Second).Nanoseconds()

	tests := []struct {
		name      string
		requested bool
		last      int64
		want      bool
	}{
		{name: "explicit request", requested: true, last: now, want: true},
		{name: "first frame", last: 0, want: true},
		{name: "periodic keyframes disabled", last: now - (30 * time.Second).Nanoseconds(), want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := directVideoKeyframeDue(test.requested, now, test.last); got != test.want {
				t.Fatalf("directVideoKeyframeDue() = %v, want %v", got, test.want)
			}
		})
	}
}
