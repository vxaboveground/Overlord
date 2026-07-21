package capture

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
	"time"

	"overlord-client/cmd/agent/config"
	rt "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/webrtcpub"
	"overlord-client/cmd/agent/wire"

	"github.com/vmihailenco/msgpack/v5"
	"nhooyr.io/websocket"
)

type recordingWriter struct {
	msgs  [][]byte
	types []websocket.MessageType
}

func (w *recordingWriter) Write(ctx context.Context, messageType websocket.MessageType, p []byte) error {
	w.types = append(w.types, messageType)
	w.msgs = append(w.msgs, append([]byte(nil), p...))
	return nil
}

func TestCaptureAndSend_NoDisplays(t *testing.T) {
	originalCount := activeDisplays
	activeDisplays = func() int { return 0 }
	t.Cleanup(func() { activeDisplays = originalCount })

	writer := &recordingWriter{}
	env := &rt.Env{Conn: writer, Cfg: config.Config{}}
	if err := CaptureAndSend(context.Background(), env); err != nil {
		t.Fatalf("expected nil error when no displays, got %v", err)
	}
	if len(writer.msgs) != 0 {
		t.Fatalf("expected no messages when no displays, got %d", len(writer.msgs))
	}
}

func TestCaptureAndSend_SendsFrame(t *testing.T) {
	previousStatsAt := lastDesktopStreamStatsMs.Swap(0)
	originalCount := activeDisplays
	originalCapture := captureDisplayFn
	activeDisplays = func() int { return 1 }
	captureDisplayFn = func(displayIndex int) (*image.RGBA, error) {
		img := image.NewRGBA(image.Rect(0, 0, 2, 2))

		img.Set(0, 0, color.RGBA{R: 200, G: 10, B: 10, A: 255})
		return img, nil
	}
	t.Cleanup(func() {
		activeDisplays = originalCount
		captureDisplayFn = originalCapture
		lastDesktopStreamStatsMs.Store(previousStatsAt)
	})

	writer := &recordingWriter{}
	env := &rt.Env{Conn: writer, Cfg: config.Config{}}
	if err := CaptureAndSend(context.Background(), env); err != nil {
		t.Fatalf("CaptureAndSend returned error: %v", err)
	}
	if len(writer.msgs) != 2 {
		t.Fatalf("expected frame and telemetry messages, got %d", len(writer.msgs))
	}

	var frame wire.Frame
	if err := msgpack.Unmarshal(writer.msgs[0], &frame); err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	if frame.Type != "frame" {
		t.Fatalf("unexpected frame type: %s", frame.Type)
	}
	if frame.Header.Format != "jpeg" {
		t.Fatalf("unexpected frame format: %s", frame.Header.Format)
	}
	if len(frame.Data) == 0 {
		t.Fatalf("expected jpeg data to be present")
	}

	if _, err := jpeg.Decode(bytes.NewReader(frame.Data)); err != nil {
		t.Fatalf("jpeg payload did not decode: %v", err)
	}

	var stats wire.DesktopStreamStats
	if err := msgpack.Unmarshal(writer.msgs[1], &stats); err != nil {
		t.Fatalf("decode desktop stream stats: %v", err)
	}
	if stats.Type != "desktop_stream_stats" || stats.Format != "jpeg" {
		t.Fatalf("unexpected stream stats: %#v", stats)
	}
	if stats.CaptureMs < 0 || stats.EncodeMs < 0 || stats.TotalMs < 0 {
		t.Fatalf("stream stats contained a negative duration: %#v", stats)
	}
}

func TestActualScreenCapture(t *testing.T) {
	displayCount := safeDisplayCount()
	if displayCount == 0 {
		t.Log("WARNING: No displays detected, skipping real screen capture test")
		return
	}

	t.Logf("Testing screen capture with %d display(s)", displayCount)

	img, err := safeCaptureDisplay(0)
	if err != nil {
		t.Logf("WARNING: Failed to capture display 0: %v", err)
		return
	}

	if img == nil {
		t.Log("WARNING: Capture returned nil image")
		return
	}

	bounds := img.Bounds()
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		t.Errorf("Invalid image dimensions: %dx%d", bounds.Dx(), bounds.Dy())
		return
	}

	t.Logf("Successfully captured %dx%d image from display 0", bounds.Dx(), bounds.Dy())

	hasVariation := false
	firstPixel := img.RGBAAt(0, 0)
	for y := 0; y < bounds.Dy() && !hasVariation; y++ {
		for x := 0; x < bounds.Dx(); x++ {
			pixel := img.RGBAAt(x, y)
			if pixel != firstPixel {
				hasVariation = true
				break
			}
		}
	}

	if !hasVariation {
		t.Log("WARNING: Captured image appears to be solid color (may indicate capture issue)")
	}

	quality := desktopJPEGQuality()
	frame, encodeDur, err := buildFrame(img, 0, quality)
	if err != nil {
		t.Errorf("Failed to build frame from captured image: %v", err)
		return
	}

	t.Logf("Encoded frame: size=%d bytes, encode_time=%s, format=%s",
		len(frame.Data), encodeDur, frame.Header.Format)

	decodedImg, err := jpeg.Decode(bytes.NewReader(frame.Data))
	if err != nil {
		t.Errorf("Failed to decode JPEG frame: %v", err)
		return
	}

	if decodedImg.Bounds().Dx() <= 0 || decodedImg.Bounds().Dy() <= 0 {
		t.Errorf("Decoded image has invalid dimensions: %dx%d",
			decodedImg.Bounds().Dx(), decodedImg.Bounds().Dy())
	}
}

func TestMultipleDisplays(t *testing.T) {
	displayCount := safeDisplayCount()
	if displayCount == 0 {
		t.Log("WARNING: No displays detected, skipping multi-display test")
		return
	}

	if displayCount == 1 {
		t.Log("Only one display detected, testing single display")
	}

	for i := 0; i < displayCount; i++ {
		t.Run("Display"+string(rune('0'+i)), func(t *testing.T) {
			img, err := safeCaptureDisplay(i)
			if err != nil {
				t.Logf("WARNING: Failed to capture display %d: %v", i, err)
				return
			}

			if img == nil {
				t.Logf("WARNING: Capture returned nil for display %d", i)
				return
			}

			bounds := img.Bounds()
			t.Logf("Display %d: %dx%d", i, bounds.Dx(), bounds.Dy())

			if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
				t.Errorf("Display %d has invalid dimensions", i)
			}
		})
	}
}

func TestSupportsCapture(t *testing.T) {
	hasDisplays := supportsCapture()
	displayCount := safeDisplayCount()

	if hasDisplays && displayCount == 0 {
		t.Error("supportsCapture returned true but displayCount is 0")
	}

	if !hasDisplays && displayCount > 0 {
		t.Error("supportsCapture returned false but displayCount > 0")
	}

	t.Logf("Capture support: %v (displays: %d)", hasDisplays, displayCount)
}

func TestCaptureWithDifferentDisplayIndices(t *testing.T) {
	displayCount := safeDisplayCount()
	if displayCount == 0 {
		t.Skip("No displays available")
	}

	tests := []struct {
		name  string
		index int
		valid bool
	}{
		{"ValidFirst", 0, true},
		{"ValidLast", displayCount - 1, true},
		{"InvalidNegative", -1, false},
		{"InvalidTooHigh", displayCount + 10, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			img, err := safeCaptureDisplay(tt.index)

			if tt.valid {
				if err != nil {
					t.Errorf("Expected valid capture, got error: %v", err)
				}
				if img == nil {
					t.Error("Expected image, got nil")
				}
			} else {

				if img != nil && err == nil {
					t.Logf("WARNING: Invalid index %d returned image instead of error", tt.index)
				}
			}
		})
	}
}

func TestFrameFPS(t *testing.T) {

	resetStats()

	for i := 0; i < 10; i++ {
		statFrames.Add(1)
	}

	fps := frameFPS(time.Now())
	if fps < 0 {
		t.Errorf("FPS should not be negative, got %d", fps)
	}

	t.Logf("Calculated FPS: %d", fps)
}

func TestJPEGQuality(t *testing.T) {
	quality := desktopJPEGQuality()
	if quality < 1 || quality > 100 {
		t.Errorf("JPEG quality out of range: %d (expected 1-100)", quality)
	}
	t.Logf("JPEG quality: %d", quality)
}

func TestCaptureAndSend_DisplayOutOfRange(t *testing.T) {
	originalCount := activeDisplays
	originalCapture := captureDisplayFn
	activeDisplays = func() int { return 2 }
	capturedDisplay := -1
	captureDisplayFn = func(displayIndex int) (*image.RGBA, error) {
		capturedDisplay = displayIndex
		img := image.NewRGBA(image.Rect(0, 0, 2, 2))
		return img, nil
	}
	t.Cleanup(func() {
		activeDisplays = originalCount
		captureDisplayFn = originalCapture
	})

	tests := []struct {
		name            string
		selectedDisplay int
		expectedDisplay int
	}{
		{"NegativeDisplay", -1, 0},
		{"TooHighDisplay", 10, 0},
		{"ValidDisplay", 1, 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			capturedDisplay = -1
			writer := &recordingWriter{}
			env := &rt.Env{
				Conn:            writer,
				Cfg:             config.Config{},
				SelectedDisplay: tt.selectedDisplay,
			}

			if err := CaptureAndSend(context.Background(), env); err != nil {
				t.Fatalf("CaptureAndSend failed: %v", err)
			}

			if capturedDisplay != tt.expectedDisplay {
				t.Errorf("expected capture from display %d, got %d", tt.expectedDisplay, capturedDisplay)
			}

			if len(writer.msgs) == 0 {
				t.Error("expected a frame message")
			} else {
				var frame wire.Frame
				if err := msgpack.Unmarshal(writer.msgs[0], &frame); err != nil || frame.Type != "frame" {
					t.Errorf("first message was not a valid frame: type=%q err=%v", frame.Type, err)
				}
			}
		})
	}
}

func TestNow_DisableCapture(t *testing.T) {
	writer := &recordingWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{DisableCapture: true},
	}

	if err := Now(context.Background(), env); err != nil {
		t.Fatalf("Now with DisableCapture failed: %v", err)
	}

	if len(writer.msgs) != 1 {
		t.Fatalf("expected 1 black frame message, got %d", len(writer.msgs))
	}

	var frame wire.Frame
	if err := msgpack.Unmarshal(writer.msgs[0], &frame); err != nil {
		t.Fatalf("failed to decode frame: %v", err)
	}

	if frame.Type != "frame" {
		t.Errorf("expected frame type 'frame', got '%s'", frame.Type)
	}

	img, err := jpeg.Decode(bytes.NewReader(frame.Data))
	if err != nil {
		t.Fatalf("failed to decode JPEG: %v", err)
	}

	bounds := img.Bounds()
	if bounds.Dx() != 64 || bounds.Dy() != 64 {
		t.Errorf("expected 64x64 black frame, got %dx%d", bounds.Dx(), bounds.Dy())
	}
}

func TestNow_NoDisplays(t *testing.T) {
	originalCount := activeDisplays
	activeDisplays = func() int { return 0 }
	t.Cleanup(func() { activeDisplays = originalCount })

	writer := &recordingWriter{}
	env := &rt.Env{Conn: writer, Cfg: config.Config{}}

	if err := Now(context.Background(), env); err != nil {
		t.Fatalf("Now with no displays failed: %v", err)
	}

	if len(writer.msgs) != 0 {
		t.Errorf("expected no messages when no displays, got %d", len(writer.msgs))
	}
}

func TestNow_Success(t *testing.T) {
	originalCount := activeDisplays
	originalCapture := captureDisplayFn
	activeDisplays = func() int { return 1 }
	captureDisplayFn = func(displayIndex int) (*image.RGBA, error) {
		img := image.NewRGBA(image.Rect(0, 0, 4, 4))
		return img, nil
	}
	t.Cleanup(func() {
		activeDisplays = originalCount
		captureDisplayFn = originalCapture
	})

	writer := &recordingWriter{}
	env := &rt.Env{Conn: writer, Cfg: config.Config{}}

	if err := Now(context.Background(), env); err != nil {
		t.Fatalf("Now failed: %v", err)
	}

	if len(writer.msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(writer.msgs))
	}

	var frame wire.Frame
	if err := msgpack.Unmarshal(writer.msgs[0], &frame); err != nil {
		t.Fatalf("failed to decode frame: %v", err)
	}

	if frame.Type != "frame" {
		t.Errorf("expected frame type 'frame', got '%s'", frame.Type)
	}
}

func TestMonitorCount(t *testing.T) {
	count := MonitorCount()

	// no monitor means weird
	if count < 1 {
		t.Errorf("expected at least 1, got %d", count)
	}

	t.Logf("MonitorCount returned: %d", count)
}

func TestCaptureAndSend_CancelledContext(t *testing.T) {
	originalCount := activeDisplays
	originalCapture := captureDisplayFn
	activeDisplays = func() int { return 1 }
	captureDisplayFn = func(displayIndex int) (*image.RGBA, error) {
		img := image.NewRGBA(image.Rect(0, 0, 2, 2))
		return img, nil
	}
	t.Cleanup(func() {
		activeDisplays = originalCount
		captureDisplayFn = originalCapture
	})

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // fuck no

	writer := &recordingWriter{}
	env := &rt.Env{Conn: writer, Cfg: config.Config{}}

	// SHOULD handle gracefully, may or may not send depending on timing :sob:
	_ = CaptureAndSend(ctx, env)
}

func TestSetFrameFlowTargetFPSScalesHighFPS(t *testing.T) {
	t.Setenv("OVERLORD_DESKTOP_IN_FLIGHT_FRAMES", "")
	ResetFrameSlots()
	SetFrameFlowTargetFPS(60)
	if got := activeFrameSlotLimit(); got != 2 {
		t.Fatalf("expected 60 fps slot limit 2, got %d", got)
	}
	SetFrameFlowTargetFPS(120)
	if got := activeFrameSlotLimit(); got != 4 {
		t.Fatalf("expected 120 fps slot limit 4, got %d", got)
	}
	SetFrameFlowTargetFPS(240)
	if got := activeFrameSlotLimit(); got != 8 {
		t.Fatalf("expected 240 fps slot limit 8, got %d", got)
	}
}

func TestSetFrameFlowTargetFPSEnvOverride(t *testing.T) {
	t.Setenv("OVERLORD_DESKTOP_IN_FLIGHT_FRAMES", "12")
	ResetFrameSlots()
	SetFrameFlowTargetFPS(240)
	if got := activeFrameSlotLimit(); got != 12 {
		t.Fatalf("expected env slot limit 12, got %d", got)
	}
}

func TestRequestDesktopFullFrameRequestsWebRTCKeyframe(t *testing.T) {
	_ = webrtcpub.ConsumeKeyframeRequest(webrtcpub.KindDesktop)

	RequestDesktopFullFrame()

	if !webrtcpub.ConsumeKeyframeRequest(webrtcpub.KindDesktop) {
		t.Fatal("expected desktop full-frame request to force the next WebRTC video frame to be a keyframe")
	}
}
