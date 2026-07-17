package webrtcpub

import (
	"sync"
	"sync/atomic"
	"time"
)

type Kind string

const (
	KindDesktop   Kind = "desktop"
	Kindbackstage Kind = "backstage"
	KindWebcam    Kind = "webcam"
	KindAudio     Kind = "audio"
)

type VideoWriter interface {
	WriteH264(nalu []byte, dur time.Duration) error
}

type AudioWriter interface {
	WriteAudio(pcm []int16) error
}

type writerEntry struct {
	video *latestVideoWriter
	audio AudioWriter
}

type latestVideoWriter struct {
	writer  VideoWriter
	mu      sync.Mutex
	pending []byte
	dur     time.Duration
	closed  bool
	wake    chan struct{}
}

func newLatestVideoWriter(writer VideoWriter) *latestVideoWriter {
	queued := &latestVideoWriter{writer: writer, wake: make(chan struct{}, 1)}
	go queued.run()
	return queued
}

func (w *latestVideoWriter) enqueue(frame []byte, dur time.Duration) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.pending = frame
	w.dur = dur
	w.mu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *latestVideoWriter) close() {
	w.mu.Lock()
	w.closed = true
	w.pending = nil
	w.mu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *latestVideoWriter) run() {
	for range w.wake {
		for {
			w.mu.Lock()
			if w.closed {
				w.mu.Unlock()
				return
			}
			frame, dur := w.pending, w.dur
			w.pending = nil
			w.mu.Unlock()
			if len(frame) == 0 {
				break
			}
			_ = w.writer.WriteH264(frame, dur)
		}
	}
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
	if entry.video != nil {
		entry.video.close()
	}
	entry.video = newLatestVideoWriter(w)
	bucket[id] = entry
	writersMu.Unlock()
	RequestKeyframe()
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
		if entry, exists := bucket[id]; exists && entry.video != nil {
			entry.video.close()
		}
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
	frame := append([]byte(nil), nalu...)
	writersMu.RLock()
	bucket := writers[string(kind)]
	targets := make([]*latestVideoWriter, 0, len(bucket))
	for _, w := range bucket {
		if w.video != nil {
			targets = append(targets, w.video)
		}
	}
	writersMu.RUnlock()
	for _, target := range targets {
		target.enqueue(frame, dur)
	}
	return nil
}

func WriteAudio(kind Kind, pcm []int16) error {
	if len(pcm) == 0 {
		return nil
	}
	writersMu.RLock()
	bucket := writers[string(kind)]
	targets := make([]AudioWriter, 0, len(bucket))
	for _, w := range bucket {
		if w.audio != nil {
			targets = append(targets, w.audio)
		}
	}
	writersMu.RUnlock()
	for _, target := range targets {
		_ = target.WriteAudio(pcm)
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
	// ICEServers contains the server-issued, short-lived Coturn configuration.
	ICEServers []ICEServer
	// HasVideo / HasAudio select which tracks to add to the peer connection.
	HasVideo bool
	HasAudio bool
}

type ICECandidate struct {
	Candidate     string `msgpack:"candidate"`
	SDPMid        string `msgpack:"sdpMid"`
	SDPMLineIndex uint16 `msgpack:"sdpMLineIndex"`
}

type ICEServer struct {
	URLs       []string
	Username   string
	Credential string
}

type P2POfferCallbacks struct {
	ICEServers          []ICEServer
	OnICE               func(c ICECandidate)
	OnClose             func()
	OnBandwidthEstimate func(bps int)
}
