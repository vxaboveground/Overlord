package capture

import (
	"image"
	"time"
)

type CaptureSmokeOptions struct {
	Display   int `json:"display"`
	Frames    int `json:"frames"`
	FPS       int `json:"fps,omitempty"`
	MaxHeight int `json:"max_height,omitempty"`
}

type CaptureSmokeResult struct {
	Backend     string  `json:"backend"`
	Format      string  `json:"format,omitempty"`
	Display     int     `json:"display"`
	Frames      int     `json:"frames"`
	Attempts    int     `json:"attempts,omitempty"`
	OK          int     `json:"ok"`
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	AvgMS       float64 `json:"avg_ms"`
	AvgCapMS    float64 `json:"avg_cap_ms,omitempty"`
	AvgEncMS    float64 `json:"avg_enc_ms,omitempty"`
	FirstEncMS  float64 `json:"first_enc_ms,omitempty"`
	SteadyEncMS float64 `json:"steady_enc_ms,omitempty"`
	MaxMS       float64 `json:"max_ms"`
	AvgBytes    float64 `json:"avg_bytes,omitempty"`
	Error       string  `json:"error,omitempty"`
}

func RunCaptureSmoke(opts CaptureSmokeOptions) []CaptureSmokeResult {
	if opts.Frames <= 0 {
		opts.Frames = 30
	}
	if opts.Display < 0 {
		opts.Display = 0
	}
	if opts.FPS > 0 {
		SetDesktopH264TargetFPS(opts.FPS)
	}
	if opts.MaxHeight != 0 {
		SetMaxResolution(opts.MaxHeight)
	}
	return []CaptureSmokeResult{
		runCaptureH264DirectSmokeCase("dxgi-h264-direct", opts.Display, opts.Frames),
		runCaptureSmokeCase("dxgi-preferred", opts.Display, opts.Frames, func(display int) (*image.RGBA, error) {
			SetDesktopDuplication(true)
			return CaptureDisplayRGBA(display)
		}),
		runCaptureSmokeCase("bitblt", opts.Display, opts.Frames, func(display int) (*image.RGBA, error) {
			SetDesktopDuplication(false)
			return CaptureDisplayRGBABitBlt(display)
		}),
	}
}

func runCaptureH264DirectSmokeCase(backend string, display, frames int) CaptureSmokeResult {
	result := CaptureSmokeResult{Backend: backend, Format: "h264", Display: display, Frames: frames}
	SetDesktopDuplication(true)
	ResetDesktopCapture()
	var total time.Duration
	var totalCap time.Duration
	var totalEnc time.Duration
	var firstEnc time.Duration
	var steadyEnc time.Duration
	var steadyCount int
	var max time.Duration
	var totalBytes int
	maxAttempts := frames * 10
	if maxAttempts < frames {
		maxAttempts = frames
	}
	for result.Attempts = 0; result.Attempts < maxAttempts && result.OK < frames; result.Attempts++ {
		start := time.Now()
		data, width, height, capDur, encDur, used, err := captureDisplayDXGIH264(display, result.OK == 0)
		dur := time.Since(start)
		total += dur
		if used {
			totalCap += capDur
			totalEnc += encDur
		}
		if dur > max {
			max = dur
		}
		if err != nil {
			if result.OK == 0 {
				result.Error = err.Error()
			}
			continue
		}
		if !used {
			if result.OK == 0 && result.Error == "" {
				result.Error = "direct path not used"
			}
			continue
		}
		if len(data) == 0 {
			if result.OK == 0 {
				result.Error = "empty h264 output"
			}
			continue
		}
		result.OK++
		result.Width = width
		result.Height = height
		totalBytes += len(data)
		result.Error = ""
		if result.OK == 1 {
			firstEnc = encDur
		} else {
			steadyEnc += encDur
			steadyCount++
		}
	}
	if result.Attempts > 0 {
		result.AvgMS = float64(total.Microseconds()) / 1000 / float64(result.Attempts)
		result.MaxMS = float64(max.Microseconds()) / 1000
	}
	if result.OK > 0 {
		result.AvgBytes = float64(totalBytes) / float64(result.OK)
		result.AvgCapMS = float64(totalCap.Microseconds()) / 1000 / float64(result.OK)
		result.AvgEncMS = float64(totalEnc.Microseconds()) / 1000 / float64(result.OK)
		result.FirstEncMS = float64(firstEnc.Microseconds()) / 1000
		if steadyCount > 0 {
			result.SteadyEncMS = float64(steadyEnc.Microseconds()) / 1000 / float64(steadyCount)
		}
	}
	return result
}

func runCaptureSmokeCase(backend string, display, frames int, fn func(int) (*image.RGBA, error)) CaptureSmokeResult {
	result := CaptureSmokeResult{Backend: backend, Display: display, Frames: frames}
	ResetDesktopCapture()
	var total time.Duration
	var max time.Duration
	for i := 0; i < frames; i++ {
		start := time.Now()
		img, err := fn(display)
		dur := time.Since(start)
		total += dur
		if dur > max {
			max = dur
		}
		if err != nil {
			result.Error = err.Error()
			continue
		}
		if img == nil {
			result.Error = "nil image"
			continue
		}
		result.OK++
		result.Width = img.Bounds().Dx()
		result.Height = img.Bounds().Dy()
		PutRGBA(img)
	}
	if frames > 0 {
		result.AvgMS = float64(total.Microseconds()) / 1000 / float64(frames)
		result.MaxMS = float64(max.Microseconds()) / 1000
	}
	return result
}
