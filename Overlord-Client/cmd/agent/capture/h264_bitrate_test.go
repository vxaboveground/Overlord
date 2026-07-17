package capture

import "testing"

func TestH264TargetBitrateAutoAndManual(t *testing.T) {
	original := configuredH264Bitrate()
	defer SetH264TargetBitrate(original)

	SetH264TargetBitrate(0)
	if got := targetH264Bitrate(1920, 1080, 60); got != 9_953_280 {
		t.Fatalf("automatic 1080p60 bitrate = %d, want 9953280", got)
	}
	if got := targetH264Bitrate(3840, 2160, 240); got != 18_000_000 {
		t.Fatalf("automatic bitrate cap = %d, want 18000000", got)
	}

	if got := SetH264TargetBitrate(30_000_000); got != 30_000_000 {
		t.Fatalf("manual bitrate = %d, want 30000000", got)
	}
	if got := targetH264Bitrate(1280, 720, 30); got != 30_000_000 {
		t.Fatalf("manual target = %d, want 30000000", got)
	}
	if got := SetH264TargetBitrate(60_000_000); got != maxH264Bitrate {
		t.Fatalf("manual cap = %d, want %d", got, maxH264Bitrate)
	}
}

func TestH264TargetCRFTracksManualRate(t *testing.T) {
	original := configuredH264Bitrate()
	defer SetH264TargetBitrate(original)
	SetH264TargetBitrate(0)
	auto := targetH264CRF(1920, 1080, 60)
	SetH264TargetBitrate(20_000_000)
	higherRate := targetH264CRF(1920, 1080, 60)
	if higherRate >= auto {
		t.Fatalf("higher bitrate CRF = %.2f, want below automatic %.2f", higherRate, auto)
	}
}

func TestWebRTCBandwidthEstimateOnlyAppliesInAdaptiveMode(t *testing.T) {
	original := configuredH264Bitrate()
	defer func() {
		SetH264NetworkAdaptive(false)
		SetH264TargetBitrate(original)
	}()

	SetH264TargetBitrate(18_000_000)
	SetH264NetworkAdaptive(false)
	if got := ApplyWebRTCBandwidthEstimate(10_000_000); got != 0 {
		t.Fatalf("disabled estimate applied %d, want 0", got)
	}
	SetH264NetworkAdaptive(true)
	lastH264NetworkAdjustment.Store(0)
	if got := ApplyWebRTCBandwidthEstimate(10_000_000); got != 9_000_000 {
		t.Fatalf("adaptive estimate applied %d, want 9000000", got)
	}
	if got := ApplyWebRTCBandwidthEstimate(2_000_000); got != 0 {
		t.Fatalf("unthrottled second estimate applied %d, want 0", got)
	}
}
