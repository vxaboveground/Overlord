package capture

import "testing"

func TestCompleteDesktopEncoderCapabilitiesAdvertisesUsableCodecs(t *testing.T) {
	caps := completeDesktopEncoderCapabilities(DesktopEncoderCapabilities{
		Profiles: []DesktopEncoderProfile{{
			MaxHeight: 1080,
			Width:     1920,
			Height:    1080,
			FPS:       60,
			Providers: []string{"Software H.264 / JPEG"},
		}},
	})

	byName := make(map[string]DesktopCodecCapability)
	for _, codec := range caps.Codecs {
		byName[codec.Codec] = codec
	}
	if _, ok := byName["jpeg"]; !ok {
		t.Fatal("expected JPEG capability")
	}
	if _, ok := byName["raw"]; !ok {
		t.Fatal("expected raw capability")
	}
	if h264Available() {
		h264, ok := byName["h264"]
		if !ok {
			t.Fatal("expected H.264 capability when the encoder is available")
		}
		if len(h264.Transports) != 2 || h264.Transports[0] != "websocket" || h264.Transports[1] != "webrtc" {
			t.Fatalf("unexpected H.264 transports: %v", h264.Transports)
		}
	}
	if hevcAvailable() {
		hevc, ok := byName["hevc"]
		if !ok {
			t.Fatal("expected HEVC capability when NVENC HEVC is available")
		}
		if len(hevc.Transports) != 1 || hevc.Transports[0] != "websocket" || !hevc.Hardware {
			t.Fatalf("unexpected HEVC capability: %+v", hevc)
		}
	} else if _, ok := byName["hevc"]; ok {
		t.Fatal("must not advertise HEVC when NVENC HEVC is unavailable")
	}
}
