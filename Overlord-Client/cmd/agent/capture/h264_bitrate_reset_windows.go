//go:build windows

package capture

func resetH264TextureEncoderForBitrate() {
	resetH264D3D11TextureEncoder()
}
