package capture

import (
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const defaultMaxInFlightFrames int64 = 2

var (
	inFlightFrames atomic.Int64
	frameAckSeen   atomic.Bool
	lastAckNano    atomic.Int64
	maxFrameSlots  atomic.Int64
)

func AcquireFrameSlot() bool {
	if !frameAckSeen.Load() {
		return true
	}

	for {
		cur := inFlightFrames.Load()
		if cur >= activeFrameSlotLimit() {
			lastAck := lastAckNano.Load()
			if lastAck > 0 && time.Since(time.Unix(0, lastAck)) > time.Second {
				inFlightFrames.Store(0)
				continue
			}
			statFrameSlotSkips.Add(1)
			return false
		}
		if inFlightFrames.CompareAndSwap(cur, cur+1) {
			return true
		}
	}
}

func ReleaseFrameSlot() {
	frameAckSeen.Store(true)
	lastAckNano.Store(time.Now().UnixNano())
	if inFlightFrames.Add(-1) < 0 {
		inFlightFrames.Store(0)
	}
}

func ResetFrameSlots() {
	inFlightFrames.Store(0)
	frameAckSeen.Store(false)
	lastAckNano.Store(0)
}

func SetFrameFlowTargetFPS(fps int) {
	limit := defaultMaxInFlightFrames
	switch {
	case fps >= 180:
		limit = 8
	case fps >= 120:
		limit = 4
	}
	if env := strings.TrimSpace(os.Getenv("OVERLORD_DESKTOP_IN_FLIGHT_FRAMES")); env != "" {
		if v, err := strconv.Atoi(env); err == nil {
			switch {
			case v < 1:
				limit = 1
			case v > 32:
				limit = 32
			default:
				limit = int64(v)
			}
		}
	}
	maxFrameSlots.Store(limit)
}

func activeFrameSlotLimit() int64 {
	if limit := maxFrameSlots.Load(); limit > 0 {
		return limit
	}
	return defaultMaxInFlightFrames
}

func frameFlowSnapshot() (inFlight, limit int64, ackSeen bool, ackAge time.Duration) {
	inFlight = inFlightFrames.Load()
	limit = activeFrameSlotLimit()
	ackSeen = frameAckSeen.Load()
	if lastAck := lastAckNano.Load(); lastAck > 0 {
		ackAge = time.Since(time.Unix(0, lastAck))
	}
	return inFlight, limit, ackSeen, ackAge
}
