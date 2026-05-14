//go:build overlord_webrtc

package webrtcpub

import (
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// G.711 μ-law parameters: 8 kHz, mono, 8-bit, 64 kbps. Universally supported
// in browsers without needing libopus / a separate Opus encoder dependency.
//
// We accept 16 kHz int16 PCM (the format malgo captures) and emit μ-law in
// 20 ms RTP packets — 160 samples per packet at 8 kHz.

const (
	pcmuSourceRate       = 16000
	pcmuTargetRate       = 8000
	pcmuPacketMs         = 20
	pcmuSamplesPerPacket = pcmuTargetRate * pcmuPacketMs / 1000 // 160
)

// pcmuAudioWriter buffers incoming 16 kHz PCM, downsamples to 8 kHz, μ-law
// encodes, and emits 20 ms RTP samples to the wrapped track. Thread-safe.
type pcmuAudioWriter struct {
	t  *webrtc.TrackLocalStaticSample
	mu sync.Mutex
	// buf8 holds 8 kHz mono int16 samples awaiting packetization.
	buf8 []int16
	// carry preserves the second sample of a 16 kHz pair across calls so
	// the decimation phase stays correct when callers hand us odd-length
	// buffers.
	carryValid bool
	carry      int16
}

func newPCMUAudioWriter(t *webrtc.TrackLocalStaticSample) *pcmuAudioWriter {
	return &pcmuAudioWriter{t: t, buf8: make([]int16, 0, pcmuSamplesPerPacket*4)}
}

// WriteAudio is called with a 16 kHz mono int16 frame. Internally it
// downsamples by 2 (pick every other sample — adequate for screen-share
// audio; if you really need anti-aliasing, run a 1-pole IIR first) and
// μ-law-encodes 20 ms slices.
func (w *pcmuAudioWriter) WriteAudio(pcm16 []int16) error {
	if len(pcm16) == 0 {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()

	start := 0
	if w.carryValid {
		w.carryValid = false
		start = 1
		_ = w.carry // value discarded — we keep one of each pair
	}
	for i := start; i < len(pcm16); i += 2 {
		w.buf8 = append(w.buf8, pcm16[i])
	}
	if (len(pcm16)-start)%2 == 1 {
		w.carryValid = true
		w.carry = pcm16[len(pcm16)-1]
	}

	for len(w.buf8) >= pcmuSamplesPerPacket {
		slice := w.buf8[:pcmuSamplesPerPacket]
		encoded := make([]byte, pcmuSamplesPerPacket)
		for i, s := range slice {
			encoded[i] = linearToMulaw(s)
		}
		if err := w.t.WriteSample(media.Sample{
			Data:     encoded,
			Duration: pcmuPacketMs * time.Millisecond,
		}); err != nil {
			w.buf8 = w.buf8[:0]
			return err
		}
		w.buf8 = w.buf8[pcmuSamplesPerPacket:]
	}
	return nil
}

func linearToMulaw(sample int16) byte {
	const (
		cBias = 0x84
		cClip = 32635
	)
	sign := int16(0)
	if sample < 0 {
		sample = -sample
		sign = 0x80
	}
	if sample > cClip {
		sample = cClip
	}
	sample += cBias
	exponent := int16(7)
	for mask := int16(0x4000); sample&mask == 0 && exponent > 0; mask >>= 1 {
		exponent--
	}
	mantissa := (sample >> (exponent + 3)) & 0x0F
	return ^byte(sign | (exponent << 4) | mantissa)
}
