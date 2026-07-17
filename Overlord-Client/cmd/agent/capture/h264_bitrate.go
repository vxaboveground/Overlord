package capture

import (
	"math"
	"sync/atomic"
	"time"
)

const maxH264Bitrate = 50_000_000

var h264TargetBitrate atomic.Int64
var h264NetworkAdaptive atomic.Bool
var lastH264NetworkAdjustment atomic.Int64

const h264NetworkAdjustmentInterval = 3 * time.Second

func SetH264NetworkAdaptive(enabled bool) {
	h264NetworkAdaptive.Store(enabled)
	if !enabled {
		lastH264NetworkAdjustment.Store(0)
	}
}

func ApplyWebRTCBandwidthEstimate(bps int) int {
	if !h264NetworkAdaptive.Load() || bps <= 0 {
		return 0
	}
	target := bps * 85 / 100
	if target < 2_000_000 {
		target = 2_000_000
	}
	if target > maxH264Bitrate {
		target = maxH264Bitrate
	}
	target = ((target + 500_000) / 1_000_000) * 1_000_000
	current := configuredH264Bitrate()
	if current > 0 {
		delta := current - target
		if delta < 0 {
			delta = -delta
		}
		if delta < 1_000_000 || float64(delta)/float64(current) < 0.15 {
			return 0
		}
	}
	now := time.Now().UnixNano()
	last := lastH264NetworkAdjustment.Load()
	if last > 0 && time.Duration(now-last) < h264NetworkAdjustmentInterval {
		return 0
	}
	if !lastH264NetworkAdjustment.CompareAndSwap(last, now) {
		return 0
	}
	return SetH264TargetBitrate(target)
}

func SetH264TargetBitrate(bps int) int {
	if bps < 0 {
		bps = 0
	}
	if bps > maxH264Bitrate {
		bps = maxH264Bitrate
	}
	previous := h264TargetBitrate.Swap(int64(bps))
	if previous != int64(bps) {
		resetH264Encoder()
		resetH264Encoderbackstage()
		resetH264TextureEncoderForBitrate()
		RequestDesktopFullFrame()
	}
	return bps
}

func configuredH264Bitrate() int {
	return int(h264TargetBitrate.Load())
}

func automaticH264Bitrate(width, height, fps int) int {
	pixelsPerSecond := float64(width * height * fps)
	bitrate := int(pixelsPerSecond * 0.08)
	if bitrate < 1_500_000 {
		return 1_500_000
	}
	if bitrate > 18_000_000 {
		return 18_000_000
	}
	return bitrate
}

func targetH264Bitrate(width, height, fps int) int {
	if configured := configuredH264Bitrate(); configured > 0 {
		return configured
	}
	return automaticH264Bitrate(width, height, fps)
}

func targetH264CRF(width, height, fps int) float32 {
	configured := configuredH264Bitrate()
	if configured <= 0 {
		return 23
	}
	ratio := float64(configured) / float64(automaticH264Bitrate(width, height, fps))
	crf := 23 - 6*math.Log2(ratio)
	if crf < 12 {
		crf = 12
	}
	if crf > 35 {
		crf = 35
	}
	return float32(crf)
}
