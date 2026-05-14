//go:build !overlord_webrtc

package webrtcpub

import (
	"context"
	"errors"
)

var ErrNotCompiled = errors.New("webrtc support not compiled in (build with -tags overlord_webrtc)")

type Publisher struct{}

func Start(_ context.Context, _ Kind, _ Options) (*Publisher, error) {
	return nil, ErrNotCompiled
}

func Stop(_ Kind)  {}
func StopAll()     {}
func (*Publisher) Close() {}

func StartP2POffer(_ context.Context, _ Kind, _ string, _ string, _ P2POfferCallbacks, _ bool, _ bool) (string, error) {
	return "", ErrNotCompiled
}

func AddP2PICECandidate(_ Kind, _ string, _ ICECandidate) {}

func StopP2P(_ Kind, _ string) {}

func StopAllP2P() {}
