package capture

import (
	"math"
	"sync/atomic"
)

const maxH264Bitrate = 50_000_000

var h264TargetBitrate atomic.Int64

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
