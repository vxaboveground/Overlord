//go:build windows

package capture

import (
	"fmt"
	"image"
	"time"
	"unsafe"
)

type H264SmokeResolution struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

type H264SmokeOptions struct {
	Frames      int                   `json:"frames"`
	Resolutions []H264SmokeResolution `json:"resolutions"`
	FPS         []int                 `json:"fps"`
	Providers   []string              `json:"providers"`
}

type H264SmokeResult struct {
	Provider       string  `json:"provider"`
	Input          string  `json:"input"`
	Width          int     `json:"width"`
	Height         int     `json:"height"`
	RequestedFPS   int     `json:"requested_fps"`
	ConfiguredFPS  int     `json:"configured_fps"`
	ConfigureOK    bool    `json:"configure_ok"`
	EncodeOK       bool    `json:"encode_ok"`
	ConfigureMS    float64 `json:"configure_ms"`
	FramesTried    int     `json:"frames_tried"`
	FramesWithData int     `json:"frames_with_data"`
	FirstOutputAt  int     `json:"first_output_at"`
	FirstOutputMS  float64 `json:"first_output_ms"`
	AvgEncodeMS    float64 `json:"avg_encode_ms"`
	MaxEncodeMS    float64 `json:"max_encode_ms"`
	AvgBytes       float64 `json:"avg_bytes"`
	TotalBytes     int     `json:"total_bytes"`
	Error          string  `json:"error,omitempty"`
	Asynchronous   bool    `json:"asynchronous"`
}

type H264MFTFinding struct {
	Index        int    `json:"index"`
	Name         string `json:"name"`
	HardwareURL  string `json:"hardware_url,omitempty"`
	Asynchronous bool   `json:"asynchronous"`
	D3D11Aware   bool   `json:"d3d11_aware"`
	ActivationOK bool   `json:"activation_ok"`
	Error        string `json:"error,omitempty"`
}

func FindH264HardwareMFTs() ([]H264MFTFinding, error) {
	if err := ensureMFStartup(); err != nil {
		return nil, err
	}
	input := mftRegisterTypeInfo{majorType: MFMediaType_Video, subtype: MFVideoFormat_NV12}
	output := mftRegisterTypeInfo{majorType: MFMediaType_Video, subtype: MFVideoFormat_H264}
	var activates **mfActivate
	var count uint32
	hr, _, _ := procMFTEnumEx.Call(
		uintptr(unsafe.Pointer(&MFT_CATEGORY_VIDEO_ENCODER)),
		uintptr(mftEnumFlagSyncMFT|mftEnumFlagAsyncMFT|mftEnumFlagHardware|mftEnumFlagSortAndFilter),
		uintptr(unsafe.Pointer(&input)), uintptr(unsafe.Pointer(&output)),
		uintptr(unsafe.Pointer(&activates)), uintptr(unsafe.Pointer(&count)),
	)
	if failedHR(hr) {
		return nil, fmt.Errorf("MFTEnumEx failed 0x%x", hr)
	}
	if activates == nil || count == 0 {
		return []H264MFTFinding{}, nil
	}
	defer procMFCoTaskMemFree.Call(uintptr(unsafe.Pointer(activates)))
	list := unsafe.Slice(activates, int(count))
	findings := make([]H264MFTFinding, 0, len(list))
	for index, activate := range list {
		finding := H264MFTFinding{Index: index}
		if activate == nil {
			finding.Error = "nil activation object"
			findings = append(findings, finding)
			continue
		}
		finding.Name, _ = activate.attrs().GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute)
		finding.HardwareURL, _ = activate.attrs().GetAllocatedString(&MFT_ENUM_HARDWARE_URL_Attribute)
		var transform *mfTransform
		hr := activate.ActivateObject(&IID_IMFTransform, unsafe.Pointer(&transform))
		if failedHR(hr) || transform == nil {
			finding.Error = fmt.Sprintf("ActivateObject failed 0x%x", hr)
		} else {
			finding.ActivationOK = true
			var attrs *mfAttributes
			if !failedHR(transform.GetAttributes(&attrs)) && attrs != nil {
				var async, d3d11 uint32
				_ = attrs.GetUINT32(&MF_TRANSFORM_ASYNC, &async)
				_ = attrs.GetUINT32(&MF_SA_D3D11_AWARE, &d3d11)
				finding.Asynchronous = async != 0
				finding.D3D11Aware = d3d11 != 0
				attrs.Release()
			}
			transform.Release()
		}
		activate.Release()
		findings = append(findings, finding)
	}
	return findings, nil
}

func DefaultH264SmokeOptions() H264SmokeOptions {
	return H264SmokeOptions{
		Frames: 30,
		Resolutions: []H264SmokeResolution{
			{Width: 1280, Height: 720},
			{Width: 1920, Height: 1080},
			{Width: 2560, Height: 1440},
			{Width: 3840, Height: 2160},
		},
		FPS:       []int{30, 60, 120},
		Providers: []string{"hardware", "software"},
	}
}

func RunH264Smoke(opts H264SmokeOptions) []H264SmokeResult {
	opts = normalizeH264SmokeOptions(opts)
	out := make([]H264SmokeResult, 0, len(opts.Resolutions)*len(opts.FPS)*len(opts.Providers)*4)
	for _, res := range opts.Resolutions {
		if res.Width <= 0 || res.Height <= 0 || res.Width%2 != 0 || res.Height%2 != 0 {
			out = append(out, H264SmokeResult{Width: res.Width, Height: res.Height, Error: "resolution must be positive and even"})
			continue
		}
		for _, fps := range opts.FPS {
			for _, provider := range opts.Providers {
				for _, candidate := range h264SmokeCandidates(provider, fps) {
					out = append(out, runH264SmokeCase(provider, res.Width, res.Height, fps, candidate, opts.Frames))
				}
			}
		}
	}
	return out
}

func normalizeH264SmokeOptions(opts H264SmokeOptions) H264SmokeOptions {
	def := DefaultH264SmokeOptions()
	if opts.Frames <= 0 {
		opts.Frames = def.Frames
	}
	if len(opts.Resolutions) == 0 {
		opts.Resolutions = def.Resolutions
	}
	if len(opts.FPS) == 0 {
		opts.FPS = def.FPS
	}
	if len(opts.Providers) == 0 {
		opts.Providers = def.Providers
	}
	return opts
}

func h264SmokeCandidates(provider string, requestedFPS int) []mfH264Candidate {
	if provider == "hardware" {
		return hardwareH264Candidates(requestedFPS)
	}
	return []mfH264Candidate{
		{fps: requestedFPS, inputSubtype: MFVideoFormat_NV12, inputFormat: "NV12"},
		{fps: requestedFPS, inputSubtype: MFVideoFormat_I420, inputFormat: "I420"},
	}
}

func runH264SmokeCase(provider string, width, height, requestedFPS int, candidate mfH264Candidate, frames int) H264SmokeResult {
	result := H264SmokeResult{
		Provider:      provider,
		Input:         candidate.inputFormat,
		Width:         width,
		Height:        height,
		RequestedFPS:  requestedFPS,
		ConfiguredFPS: candidate.fps,
		FirstOutputAt: -1,
	}
	if err := ensureMFStartup(); err != nil {
		result.Error = err.Error()
		return result
	}

	transform, hardware, providerName, err := createH264SmokeTransform(provider)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.Provider = providerName
	enc := newMFH264EncoderFromTransform(transform, width, height, requestedFPS, candidate.fps, hardware, providerName, candidate.inputSubtype, candidate.inputFormat)

	t0 := time.Now()
	configureErr := enc.configure()
	result.Asynchronous = enc.asynchronous
	if configureErr != nil {
		result.ConfigureMS = float64(time.Since(t0).Microseconds()) / 1000
		result.Error = configureErr.Error()
		enc.Close()
		return result
	}
	result.ConfigureOK = true
	result.ConfigureMS = float64(time.Since(t0).Microseconds()) / 1000
	defer enc.Close()

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	totalEncode := time.Duration(0)
	maxEncode := time.Duration(0)
	firstStart := time.Now()
	for frame := 0; frame < frames; frame++ {
		fillH264SmokeFrame(img, frame)
		encStart := time.Now()
		data, err := enc.Encode(img)
		encDur := time.Since(encStart)
		result.FramesTried++
		totalEncode += encDur
		if encDur > maxEncode {
			maxEncode = encDur
		}
		if err != nil {
			result.Error = err.Error()
			return result
		}
		if len(data) > 0 {
			result.FramesWithData++
			result.TotalBytes += len(data)
			if result.FirstOutputAt < 0 {
				result.FirstOutputAt = frame + 1
				result.FirstOutputMS = float64(time.Since(firstStart).Microseconds()) / 1000
			}
		}
	}
	if result.FramesTried > 0 {
		result.AvgEncodeMS = float64(totalEncode.Microseconds()) / 1000 / float64(result.FramesTried)
		result.MaxEncodeMS = float64(maxEncode.Microseconds()) / 1000
	}
	if result.FramesWithData > 0 {
		result.EncodeOK = true
		result.AvgBytes = float64(result.TotalBytes) / float64(result.FramesWithData)
	}
	if !result.EncodeOK {
		result.Error = "configured but produced no output"
	}
	return result
}

func createH264SmokeTransform(provider string) (*mfTransform, bool, string, error) {
	switch provider {
	case "hardware":
		transform, detail, err := activateHardwareH264MFTDetailed()
		if err != nil {
			return nil, false, "hardware", err
		}
		return transform, true, detail.provider(), nil
	case "software":
		return createSoftwareH264Transform()
	default:
		return nil, false, provider, fmt.Errorf("unknown provider %q", provider)
	}
}

func fillH264SmokeFrame(img *image.RGBA, frame int) {
	width := img.Bounds().Dx()
	height := img.Bounds().Dy()
	for y := 0; y < height; y++ {
		row := img.Pix[y*img.Stride:]
		for x := 0; x < width; x++ {
			i := x * 4
			row[i+0] = byte((x + frame*7) & 0xff)
			row[i+1] = byte((y + frame*5) & 0xff)
			row[i+2] = byte((x/2 + y/3 + frame*11) & 0xff)
			row[i+3] = 255
		}
	}
}
