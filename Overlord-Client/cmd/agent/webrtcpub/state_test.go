package webrtcpub

import (
	"sync"
	"testing"
	"time"
)

type blockingVideoWriter struct {
	started chan struct{}
	release chan struct{}
	mu      sync.Mutex
	frames  [][]byte
}

func (w *blockingVideoWriter) WriteH264(frame []byte, _ time.Duration) error {
	w.mu.Lock()
	w.frames = append(w.frames, append([]byte(nil), frame...))
	count := len(w.frames)
	w.mu.Unlock()
	if count == 1 {
		close(w.started)
		<-w.release
	}
	return nil
}

func TestWriteH264DoesNotBlockAndKeepsLatestPendingFrame(t *testing.T) {
	kind := Kind("queue-test")
	id := "slow-writer"
	writer := &blockingVideoWriter{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	registerVideoWriter(kind, id, writer)
	defer unregisterWriter(kind, id)

	if err := WriteH264(kind, []byte{1}, time.Millisecond); err != nil {
		t.Fatal(err)
	}
	select {
	case <-writer.started:
	case <-time.After(time.Second):
		t.Fatal("writer did not receive first frame")
	}

	started := time.Now()
	_ = WriteH264(kind, []byte{2}, time.Millisecond)
	_ = WriteH264(kind, []byte{3}, time.Millisecond)
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("capture path blocked for %s", elapsed)
	}
	close(writer.release)

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		writer.mu.Lock()
		frames := append([][]byte(nil), writer.frames...)
		writer.mu.Unlock()
		if len(frames) >= 2 {
			if frames[0][0] != 1 || frames[1][0] != 3 {
				t.Fatalf("expected first and latest frames, got %v", frames)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("latest pending frame was not delivered")
}

func TestKeyframeRequestsAreIsolatedByStreamKind(t *testing.T) {
	for _, kind := range []Kind{KindDesktop, Kindbackstage, KindWebcam} {
		_ = ConsumeKeyframeRequest(kind)
	}

	RequestKeyframe(Kindbackstage)

	if ConsumeKeyframeRequest(KindDesktop) {
		t.Fatal("backstage keyframe request leaked into desktop stream")
	}
	if ConsumeKeyframeRequest(KindWebcam) {
		t.Fatal("backstage keyframe request leaked into webcam stream")
	}
	if !ConsumeKeyframeRequest(Kindbackstage) {
		t.Fatal("backstage keyframe request was not retained for backstage stream")
	}
}
