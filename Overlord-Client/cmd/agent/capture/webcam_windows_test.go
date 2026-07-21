//go:build windows && cgo

package capture

import (
	"context"
	"os"
	"testing"
	"time"

	rt "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"

	"github.com/vmihailenco/msgpack/v5"
)

func TestActiveWebcamFrameFPS(t *testing.T) {
	tests := []struct {
		name       string
		requested  int
		captureFPS float64
		want       int
	}{
		{name: "requested rate", requested: 15, captureFPS: 30, want: 15},
		{name: "camera limit", requested: 60, captureFPS: 30, want: 30},
		{name: "camera default", captureFPS: 29.97, want: 30},
		{name: "safe default", want: 30},
		{name: "protocol limit", requested: 240, captureFPS: 240, want: 120},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := activeWebcamFrameFPS(test.requested, test.captureFPS); got != test.want {
				t.Fatalf("activeWebcamFrameFPS(%d, %.2f) = %d, want %d", test.requested, test.captureFPS, got, test.want)
			}
		})
	}
}

func TestWebcamCaptureSmoke(t *testing.T) {
	if os.Getenv("OVERLORD_WEBCAM_SMOKE") != "1" {
		t.Skip("set OVERLORD_WEBCAM_SMOKE=1 to exercise an attached camera")
	}

	writer := &recordingWriter{}
	env := &rt.Env{
		Conn:              writer,
		WebcamDeviceIndex: 0,
		WebcamFPS:         30,
		WebcamQuality:     90,
		WebcamCodec:       "jpeg",
	}
	t.Cleanup(CleanupWebcam)

	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if err := NowWebcam(context.Background(), env); err != nil {
			t.Fatalf("capture webcam frame: %v", err)
		}
		if len(writer.msgs) > 0 {
			var frame wire.Frame
			if err := msgpack.Unmarshal(writer.msgs[0], &frame); err != nil {
				t.Fatalf("decode webcam frame: %v", err)
			}
			if !frame.Header.Webcam || frame.Header.FPS <= 0 || len(frame.Data) == 0 {
				t.Fatalf("invalid live webcam frame: header=%+v bytes=%d", frame.Header, len(frame.Data))
			}
			t.Logf("captured webcam format=%s fps=%d bytes=%d", frame.Header.Format, frame.Header.FPS, len(frame.Data))
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("timed out waiting for a live webcam frame")
}
