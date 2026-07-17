//go:build overlord_webrtc

package webrtcpub

import (
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/thesyncim/gopus"
)

const (
	opusInputRate       = 48000
	opusChannels        = 2
	opusPacketMs        = 20
	opusSamplesPerFrame = opusInputRate * opusPacketMs / 1000
	opusBitrate         = 96000
)

type opusAudioWriter struct {
	t       *webrtc.TrackLocalStaticSample
	encoder *gopus.Encoder
	mu      sync.Mutex
	pcm     []int16
	packet  []byte
}

func newOpusAudioWriter(t *webrtc.TrackLocalStaticSample) (*opusAudioWriter, error) {
	encoder, err := gopus.NewEncoder(gopus.EncoderConfig{
		SampleRate:  opusInputRate,
		Channels:    opusChannels,
		Application: gopus.ApplicationAudio,
	})
	if err != nil {
		return nil, err
	}
	if err := encoder.SetBitrate(opusBitrate); err != nil {
		return nil, err
	}
	if err := encoder.SetInBandFEC(gopus.InBandFECEnabled); err != nil {
		return nil, err
	}
	return &opusAudioWriter{
		t:       t,
		encoder: encoder,
		pcm:     make([]int16, 0, opusSamplesPerFrame*4),
		packet:  make([]byte, 4000),
	}, nil
}

func (w *opusAudioWriter) WriteAudio(pcm []int16) error {
	if len(pcm) == 0 {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pcm = append(w.pcm, pcm...)
	frameValues := opusSamplesPerFrame * opusChannels
	for len(w.pcm) >= frameValues {
		n, err := w.encoder.EncodeInt16(w.pcm[:frameValues], w.packet)
		if err != nil {
			w.pcm = w.pcm[:0]
			return err
		}
		if n > 0 {
			if err := w.t.WriteSample(media.Sample{
				Data:     w.packet[:n],
				Duration: opusPacketMs * time.Millisecond,
			}); err != nil {
				w.pcm = w.pcm[:0]
				return err
			}
		}
		w.pcm = w.pcm[frameValues:]
	}
	return nil
}
