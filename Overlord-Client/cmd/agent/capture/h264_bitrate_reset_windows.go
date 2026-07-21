//go:build windows

package capture

func resetH264TextureEncoderForBitrate() {
	resetAllH264D3D11TextureEncoders()
}
