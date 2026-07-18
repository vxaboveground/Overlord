//go:build !windows || !cgo || no_nvenc

package capture

import (
	"fmt"
	"time"
	"unsafe"
)

type NVENCD3D11SmokeOptions struct {
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	FPS     int    `json:"fps"`
	Frames  int    `json:"frames"`
	Bitrate int    `json:"bitrate"`
	Codec   string `json:"codec,omitempty"`
}

type NVENCD3D11SmokeResult struct {
	OK         bool    `json:"ok"`
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	FPS        int     `json:"fps"`
	Frames     int     `json:"frames"`
	FirstMS    float64 `json:"first_ms"`
	AvgMS      float64 `json:"avg_ms"`
	TotalBytes uint64  `json:"total_bytes"`
	Error      string  `json:"error,omitempty"`
	Stage      int     `json:"stage,omitempty"`
	HRESULT    uint32  `json:"hresult,omitempty"`
	NVStatus   int     `json:"nv_status,omitempty"`
	Message    string  `json:"message,omitempty"`
}

func RunNVENCD3D11Smoke(opts NVENCD3D11SmokeOptions) NVENCD3D11SmokeResult {
	return NVENCD3D11SmokeResult{
		Width:   opts.Width,
		Height:  opts.Height,
		FPS:     opts.FPS,
		Frames:  opts.Frames,
		Error:   "NVENC D3D11 smoke requires Windows with cgo enabled",
		Message: "NVENC D3D11 smoke requires Windows with cgo enabled",
	}
}

func probeNativeD3D11TextureProfile(_, _ unsafe.Pointer, _, _, _, _, _ int, _ uint32) (time.Duration, error) {
	return 0, fmt.Errorf("NVENC D3D11 support is not compiled in")
}
