//go:build !cgo

package audio

import (
	"context"
	"errors"
)

type Session struct{}

func ProbeCapabilities() Capabilities {
	return Capabilities{
		Available:     false,
		RequiresCGO:   true,
		Sources:       []string{"default"},
		DefaultSource: "default",
		Detail:        "native voice support requires a CGO-enabled build",
	}
}

func StartVoiceSession(_ context.Context, _ string, _ func([]byte)) (*Session, error) {
	return nil, errors.New("native voice support requires a CGO-enabled build")
}

func (s *Session) WritePlayback(_ []byte) error {
	return errors.New("voice session is unavailable")
}

func (s *Session) Close() error {
	return nil
}

func StartCaptureOnlySession(_ context.Context, _ string, _ func([]byte)) (*Session, error) {
	return nil, errors.New("native voice support requires a CGO-enabled build")
}
