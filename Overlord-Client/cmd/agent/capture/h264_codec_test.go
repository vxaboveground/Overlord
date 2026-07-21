package capture

import (
	"errors"
	"fmt"
	"image"
	"image/color"
	"os"
	"strings"
	"sync"
	"testing"
)

func resetCodecSelectionForTest() {
	blockCodecOnce = sync.Once{}
	cachedBlockCodec = ""
	desktopOverrideCodec.Store("")
	backstageOverrideCodec.Store("")
	desktopOverrideQuality.Store(0)
	backstageOverrideQuality.Store(0)
}

func TestSetQualityAndCodec_H264FallbackDependsOnAvailability(t *testing.T) {
	t.Cleanup(resetCodecSelectionForTest)

	SetDesktopQualityAndCodec(80, "h264")
	got := desktopCodec()

	if h264Available() {
		if got != "h264" {
			t.Fatalf("expected h264 codec when available, got %q", got)
		}
		return
	}

	if got != "jpeg" {
		t.Fatalf("expected jpeg fallback when h264 unavailable, got %q", got)
	}
}

func TestSetQualityAndCodec_InvalidCodecForcesJpeg(t *testing.T) {
	t.Cleanup(resetCodecSelectionForTest)

	SetDesktopQualityAndCodec(75, "invalid-codec")
	got := desktopCodec()
	if got != "jpeg" {
		t.Fatalf("expected invalid codec to force jpeg, got %q", got)
	}
}

func TestDesktopAndBackstageCodecSelectionsAreIndependent(t *testing.T) {
	t.Cleanup(resetCodecSelectionForTest)

	SetDesktopQualityAndCodec(80, "h264")
	SetBackstageQualityAndCodec(65, "jpeg")

	wantDesktop := "jpeg"
	if h264Available() {
		wantDesktop = "h264"
	}
	if got := desktopCodec(); got != wantDesktop {
		t.Fatalf("desktop codec = %q, want %q after backstage update", got, wantDesktop)
	}
	if got := backstageCodec(); got != "jpeg" {
		t.Fatalf("backstage codec = %q, want jpeg", got)
	}
	if got := desktopJPEGQuality(); got != 80 {
		t.Fatalf("desktop quality = %d, want 80", got)
	}
	if got := backstageJPEGQuality(); got != 65 {
		t.Fatalf("backstage quality = %d, want 65", got)
	}
}

func TestDesktopHardwareFailureDoesNotChangeBackstageCodec(t *testing.T) {
	t.Cleanup(func() {
		desktopHardwareFallbackUntil.Store(0)
		resetCodecSelectionForTest()
	})
	SetDesktopQualityAndCodec(80, "h264")
	SetBackstageQualityAndCodec(65, "h264")
	before := backstageCodec()

	suppressDesktopHardwareH264(errors.New("NVENC session failure"))

	if !useDesktopSoftwareH264() {
		t.Fatal("desktop did not enter temporary software H.264 fallback")
	}
	if got := backstageCodec(); got != before {
		t.Fatalf("backstage codec changed from %q to %q after desktop encoder failure", before, got)
	}
}

func TestH264AvailabilityDetail_NotEmpty(t *testing.T) {
	detail := strings.TrimSpace(h264AvailabilityDetail())
	if detail == "" {
		t.Fatal("expected h264 availability detail to be non-empty")
	}
}

func TestEncodeH264Frame_WhenUnavailableReturnsError(t *testing.T) {
	if h264Available() {
		t.Skip("h264 is available in this build; unavailable-path assertion does not apply")
	}

	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	out, err := encodeH264Frame(img)
	if err == nil {
		t.Fatal("expected an error when h264 is unavailable")
	}
	if out != nil {
		t.Fatalf("expected nil output when h264 is unavailable, got %d bytes", len(out))
	}
}

func TestEncodeH264Frame_WhenAvailableProducesBytes(t *testing.T) {
	if !h264Available() {
		t.Skip("h264 is unavailable in this build")
	}
	t.Cleanup(resetH264Encoder)

	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	var got []byte
	for frame := 0; frame < 8; frame++ {
		for y := 0; y < 64; y++ {
			for x := 0; x < 64; x++ {
				img.SetRGBA(x, y, color.RGBA{R: uint8(x*3 + frame*7), G: uint8(y * 3), B: uint8(80 + frame*11), A: 255})
			}
		}
		out, err := encodeH264Frame(img)
		if err != nil {
			t.Fatalf("encodeH264Frame failed: %v", err)
		}
		if len(out) > 0 {
			got = out
			break
		}
	}
	if len(got) == 0 {
		t.Fatal("expected h264 encoder to produce bytes")
	}
}

func TestDesktopAndBackstageH264EncodeConcurrently(t *testing.T) {
	if !h264Available() {
		t.Skip("h264 is unavailable in this build")
	}
	SetDesktopH264TargetFPS(60)
	SetBackstageH264TargetFPS(30)
	t.Cleanup(func() {
		resetH264Encoder()
		resetH264Encoderbackstage()
	})

	const width, height = 640, 360
	start := make(chan struct{})
	results := make(chan error, 2)
	run := func(name string, encode func(*image.RGBA) ([]byte, error), seed uint8) {
		<-start
		img := image.NewRGBA(image.Rect(0, 0, width, height))
		produced := false
		for frame := range 12 {
			for y := range height {
				for x := range width {
					img.SetRGBA(x, y, color.RGBA{
						R: uint8(x*3+frame*7) + seed,
						G: uint8(y*3+frame*5) + seed,
						B: uint8(frame*11) + seed,
						A: 255,
					})
				}
			}
			out, err := encode(img)
			if err != nil {
				results <- fmt.Errorf("%s encode frame %d: %w", name, frame, err)
				return
			}
			produced = produced || len(out) > 0
		}
		if !produced {
			results <- fmt.Errorf("%s produced no H.264 output", name)
			return
		}
		results <- nil
	}

	go run("desktop", encodeH264Frame, 17)
	go run("backstage", encodeH264Framebackstage, 83)
	close(start)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
}

func TestBackstageFirstFrameRequestsDesktopRecoveryOnce(t *testing.T) {
	desktopRecoveryAfterBackstageStart.Store(false)
	t.Cleanup(func() {
		desktopRecoveryAfterBackstageStart.Store(false)
	})

	RequestDesktopRecoveryAfterBackstageStart()
	if recoverDesktopAfterBackstageFrame(0) {
		t.Fatal("empty backstage frame consumed desktop recovery request")
	}
	if !recoverDesktopAfterBackstageFrame(1) {
		t.Fatal("first completed backstage frame did not request desktop recovery")
	}
	if recoverDesktopAfterBackstageFrame(1) {
		t.Fatal("desktop recovery request was not consumed exactly once")
	}
}

func TestBlockCodec_UsesEnvWhenNoOverride(t *testing.T) {
	prev := os.Getenv(blockCodecEnv)
	if err := os.Setenv(blockCodecEnv, "raw"); err != nil {
		t.Fatalf("setenv failed: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Setenv(blockCodecEnv, prev)
		resetCodecSelectionForTest()
	})

	resetCodecSelectionForTest()
	got := desktopCodec()
	if got != "raw" {
		t.Fatalf("expected env codec raw, got %q", got)
	}
}
