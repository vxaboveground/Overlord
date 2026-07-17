package capture

import (
	"context"
	"sync/atomic"
	"time"

	rt "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

var lastDesktopStreamStatsMs atomic.Int64

func emitDesktopStreamStats(ctx context.Context, env *rt.Env, frame wire.Frame, fps int, captureDur, encodeDur, sendDur, totalDur time.Duration, transport string) {
	now := time.Now().UnixMilli()
	previous := lastDesktopStreamStatsMs.Load()
	if now-previous < 500 || !lastDesktopStreamStatsMs.CompareAndSwap(previous, now) {
		return
	}
	_ = wire.WriteMsg(ctx, env.Conn, wire.DesktopStreamStats{
		Type:      "desktop_stream_stats",
		FPS:       fps,
		Format:    frame.Header.Format,
		Bytes:     len(frame.Data),
		Width:     frame.Header.Width,
		Height:    frame.Header.Height,
		CaptureMs: durationMs(captureDur),
		EncodeMs:  durationMs(encodeDur),
		SendMs:    durationMs(sendDur),
		TotalMs:   durationMs(totalDur),
		Transport: transport,
	})
}

func durationMs(value time.Duration) float64 {
	return float64(value.Microseconds()) / 1000
}
