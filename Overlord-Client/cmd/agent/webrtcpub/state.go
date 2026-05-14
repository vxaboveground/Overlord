package webrtcpub

import (
	"sync"
	"sync/atomic"
	"time"
)

type Kind string

const (
	KindDesktop Kind = "desktop"
	KindWebcam  Kind = "webcam"
	KindAudio   Kind = "audio"
)

type VideoWriter interface {
	WriteH264(nalu []byte, dur time.Duration) error
}

type AudioWriter interface {
	WriteAudio(pcm []int16) error
}

type writerEntry struct {
	video VideoWriter
	audio AudioWriter
}

var (
	writersMu sync.RWMutex
	writers   = map[string]map[string]writerEntry{} // kind → id → entry
)

func registerVideoWriter(kind Kind, id string, w VideoWriter) {
	if id == "" || w == nil {
		return
	}
	writersMu.Lock()
	bucket := writers[string(kind)]
	if bucket == nil {
		bucket = map[string]writerEntry{}
		writers[string(kind)] = bucket
	}
	entry := bucket[id]
	entry.video = w
	bucket[id] = entry
	writersMu.Unlock()
}

func registerAudioWriter(kind Kind, id string, w AudioWriter) {
	if id == "" || w == nil {
		return
	}
	writersMu.Lock()
	bucket := writers[string(kind)]
	if bucket == nil {
		bucket = map[string]writerEntry{}
		writers[string(kind)] = bucket
	}
	entry := bucket[id]
	entry.audio = w
	bucket[id] = entry
	writersMu.Unlock()
}

func unregisterWriter(kind Kind, id string) {
	if id == "" {
		return
	}
	writersMu.Lock()
	if bucket, ok := writers[string(kind)]; ok {
		delete(bucket, id)
		if len(bucket) == 0 {
			delete(writers, string(kind))
		}
	}
	writersMu.Unlock()
}

// IsActive reports whether any writer of the given kind is registered.
// Callers in capture loops use this as a cheap "should I divert this frame
// to WebRTC?" check before doing more expensive work.
func IsActive(kind Kind) bool {
	writersMu.RLock()
	defer writersMu.RUnlock()
	return len(writers[string(kind)]) > 0
}

var keyframeWanted atomic.Bool

func RequestKeyframe() {
	keyframeWanted.Store(true)
}

func ConsumeKeyframeRequest() bool {
	return keyframeWanted.Swap(false)
}

func WriteH264(kind Kind, nalu []byte, dur time.Duration) error {
	if len(nalu) == 0 {
		return nil
	}
	writersMu.RLock()
	defer writersMu.RUnlock()
	bucket := writers[string(kind)]
	for _, w := range bucket {
		if w.video != nil {
			_ = w.video.WriteH264(nalu, dur)
		}
	}
	return nil
}

func WriteAudio(kind Kind, pcm []int16) error {
	if len(pcm) == 0 {
		return nil
	}
	writersMu.RLock()
	defer writersMu.RUnlock()
	bucket := writers[string(kind)]
	for _, w := range bucket {
		if w.audio != nil {
			_ = w.audio.WriteAudio(pcm)
		}
	}
	return nil
}

type Options struct {
	// (e.g. https://server:5173/api/webrtc/agents/abc/desktop/whip).
	WhipURL string
	// PublishToken is the bearer token issued by the server.
	PublishToken string
	// TLSInsecureSkipVerify mirrors the agent's existing TLS config.
	TLSInsecureSkipVerify bool
	// TLSCAPath is an optional custom CA bundle.
	TLSCAPath string
	// HasVideo / HasAudio select which tracks to add to the peer connection.
	HasVideo bool
	HasAudio bool
}

type ICECandidate struct {
	Candidate     string `msgpack:"candidate"`
	SDPMid        string `msgpack:"sdpMid"`
	SDPMLineIndex uint16 `msgpack:"sdpMLineIndex"`
}

type P2POfferCallbacks struct {
	OnICE   func(c ICECandidate)
	OnClose func()
}
