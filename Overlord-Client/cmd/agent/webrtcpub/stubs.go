//go:build !overlord_webrtc

package webrtcpub

import (
	"context"
	"errors"
)

var ErrNotCompiled = errors.New("webrtc support not compiled in (build with -tags overlord_webrtc)")

type Publisher struct{}

func Start(_ context.Context, _ Options) (*Publisher, error) {
	return nil, ErrNotCompiled
}

func Stop() {}

func (*Publisher) Close() {}

func StartP2POffer(_ context.Context, _ string, _ string, _ P2POfferCallbacks) (string, error) {
	return "", ErrNotCompiled
}

func AddP2PICECandidate(_ string, _ ICECandidate) {}

func StopP2P() {}
