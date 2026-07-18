//go:build windows && (!cgo || no_nvenc)

package capture

import "fmt"
import "unsafe"

func newNativeH264Encoder(stream string, width, height, fps int) (h264FrameEncoder, error) {
	return nil, fmt.Errorf("native NVENC D3D11 requires cgo for %dx%d@%dfps", width, height, fps)
}

func newNativeHEVCEncoder(stream string, width, height, fps int) (h264FrameEncoder, error) {
	return nil, fmt.Errorf("native NVENC HEVC requires cgo for %dx%d@%dfps", width, height, fps)
}

func nativeH264AvailabilityDetail() string {
	return ""
}

func encodeNativeH264D3D11Texture(device, texture unsafe.Pointer, inputWidth, inputHeight, encodeWidth, encodeHeight, fps int, dxgiFormat uint32, forceIDR bool) ([]byte, error) {
	return nil, fmt.Errorf("native NVENC D3D11 texture encode requires cgo for input=%dx%d output=%dx%d@%dfps", inputWidth, inputHeight, encodeWidth, encodeHeight, fps)
}

func requestNativeH264D3D11TextureKeyframe() {}

func resetNativeH264D3D11TextureEncoder() {}

func encodeNativeHEVCD3D11Texture(device, texture unsafe.Pointer, inputWidth, inputHeight, encodeWidth, encodeHeight, fps int, dxgiFormat uint32, forceIDR bool) ([]byte, error) {
	return nil, fmt.Errorf("native NVENC HEVC D3D11 texture encode requires cgo for input=%dx%d output=%dx%d@%dfps", inputWidth, inputHeight, encodeWidth, encodeHeight, fps)
}

func requestNativeHEVCD3D11TextureKeyframe() {}

func resetNativeHEVCD3D11TextureEncoder() {}
