package main

import (
	"errors"
	"net/http"
	"os"
	"testing"
	"time"

	"overlord-client/cmd/agent/config"
	"overlord-client/cmd/agent/handlers"

	"nhooyr.io/websocket"
)

func withEnv(key, value string, fn func()) {
	old, ok := os.LookupEnv(key)
	if value == "" {
		_ = os.Unsetenv(key)
	} else {
		_ = os.Setenv(key, value)
	}
	defer func() {
		if ok {
			_ = os.Setenv(key, old)
		} else {
			_ = os.Unsetenv(key)
		}
	}()
	fn()
}

func TestGetPingInterval_Default(t *testing.T) {
	withEnv("OVERLORD_PING_INTERVAL_MS", "", func() {
		interval := getPingInterval()
		if interval != 30*time.Second {
			t.Fatalf("expected 30s, got %s", interval)
		}
	})
}

func TestGetPingInterval_Custom(t *testing.T) {
	withEnv("OVERLORD_PING_INTERVAL_MS", "0", func() {
		interval := getPingInterval()
		if interval != 0 {
			t.Fatalf("expected 0, got %s", interval)
		}
	})
}

func TestGetPingInterval_Invalid(t *testing.T) {
	withEnv("OVERLORD_PING_INTERVAL_MS", "oops", func() {
		interval := getPingInterval()
		if interval != 30*time.Second {
			t.Fatalf("expected 30s on invalid input, got %s", interval)
		}
	})
}

func TestReconnectDelay_Custom(t *testing.T) {
	withEnv("OVERLORD_RECONNECT_DELAY_MS", "0", func() {
		delay := reconnectDelay()
		if delay != 0 {
			t.Fatalf("expected 0, got %s", delay)
		}
	})
}

func TestReconnectDelay_Invalid(t *testing.T) {
	withEnv("OVERLORD_RECONNECT_DELAY_MS", "bad", func() {
		delay := reconnectDelay()
		if delay < 1*time.Second || delay > 3*time.Second {
			t.Fatalf("expected 1-3s, got %s", delay)
		}
	})
}

func TestShouldRetryImmediately(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "normal closure",
			err:  &websocket.CloseError{Code: websocket.StatusNormalClosure},
			want: true,
		},
		{
			name: "going away",
			err:  &websocket.CloseError{Code: websocket.StatusGoingAway},
			want: true,
		},
		{
			name: "abnormal closure",
			err:  &websocket.CloseError{Code: websocket.StatusAbnormalClosure},
			want: true,
		},
		{
			name: "timeout string",
			err:  errors.New("timed out from inactivity"),
			want: true,
		},
		{
			name: "other error",
			err:  errors.New("something else"),
			want: false,
		},
		{
			name: "explicit reconnect",
			err:  handlers.ErrReconnect,
			want: true,
		},
	}

	for _, tc := range cases {
		if got := shouldRetryImmediately(tc.err); got != tc.want {
			t.Fatalf("%s: expected %v, got %v", tc.name, tc.want, got)
		}
	}
}

func TestBuildDialOptions(t *testing.T) {
	transport := &http.Transport{}
	opts := buildDialOptions(config.Config{}, transport)
	if len(opts.Subprotocols) != 1 || opts.Subprotocols[0] != "binary" {
		t.Fatalf("expected binary subprotocol, got %v", opts.Subprotocols)
	}
	if opts.CompressionMode != websocket.CompressionContextTakeover {
		t.Fatalf("expected compression takeover, got %v", opts.CompressionMode)
	}
	if opts.HTTPClient == nil || opts.HTTPClient.Transport != transport {
		t.Fatalf("expected http client to use provided transport")
	}
}
