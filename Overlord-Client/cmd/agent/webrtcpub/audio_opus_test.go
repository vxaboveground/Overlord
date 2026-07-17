//go:build overlord_webrtc

package webrtcpub

import (
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestOpusAudioWriterAcceptsFragmentedStereoPCM(t *testing.T) {
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio", "test",
	)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := newOpusAudioWriter(track)
	if err != nil {
		t.Fatal(err)
	}
	frame := make([]int16, opusSamplesPerFrame*opusChannels)
	if err := writer.WriteAudio(frame[:333]); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteAudio(frame[333:]); err != nil {
		t.Fatal(err)
	}
	if len(writer.pcm) != 0 {
		t.Fatalf("buffered PCM = %d, want 0 after a complete frame", len(writer.pcm))
	}
}
