package capture

import (
	"image"
	"testing"
)

func TestHEVCEncoderProducesAnnexBHeadersAndKeyframe(t *testing.T) {
	if !hevcAvailable() {
		t.Skipf("HEVC encoder unavailable: %s", hevcAvailabilityDetail())
	}
	resetHEVCEncoder()
	t.Cleanup(resetHEVCEncoder)

	frame := image.NewRGBA(image.Rect(0, 0, 1280, 720))
	encoded, err := encodeHEVCFrame(frame)
	if err != nil {
		t.Fatalf("encode HEVC frame: %v", err)
	}
	if len(encoded) == 0 {
		t.Fatal("HEVC encoder returned an empty frame")
	}

	nalTypes := hevcAnnexBNALTypes(encoded)
	for _, required := range []byte{32, 33, 34} {
		if !containsByte(nalTypes, required) {
			t.Fatalf("HEVC frame missing NAL type %d; got %v", required, nalTypes)
		}
	}
	hasIntra := false
	for _, nalType := range nalTypes {
		if nalType >= 16 && nalType <= 21 {
			hasIntra = true
			break
		}
	}
	if !hasIntra {
		t.Fatalf("HEVC first frame is not an IRAP keyframe; got NAL types %v", nalTypes)
	}
}

func TestHEVCD3D11TexturePipeline(t *testing.T) {
	if !hevcAvailable() {
		t.Skipf("HEVC encoder unavailable: %s", hevcAvailabilityDetail())
	}
	result := RunNVENCD3D11Smoke(NVENCD3D11SmokeOptions{
		Width: 1280, Height: 720, FPS: 60, Frames: 4, Codec: "hevc",
	})
	if !result.OK {
		t.Fatalf("HEVC D3D11 texture pipeline failed: %+v", result)
	}
	if result.TotalBytes == 0 {
		t.Fatal("HEVC D3D11 texture pipeline produced no output")
	}
	t.Logf("HEVC D3D11 texture pipeline: first=%.2fms avg=%.2fms bytes=%d", result.FirstMS, result.AvgMS, result.TotalBytes)
}

func hevcAnnexBNALTypes(data []byte) []byte {
	types := make([]byte, 0, 8)
	for i := 0; i+4 < len(data); i++ {
		startCodeLen := 0
		if data[i] == 0 && data[i+1] == 0 && data[i+2] == 1 {
			startCodeLen = 3
		} else if i+4 < len(data) && data[i] == 0 && data[i+1] == 0 && data[i+2] == 0 && data[i+3] == 1 {
			startCodeLen = 4
		}
		if startCodeLen == 0 {
			continue
		}
		nalIndex := i + startCodeLen
		if nalIndex < len(data) {
			types = append(types, (data[nalIndex]>>1)&0x3f)
			i = nalIndex
		}
	}
	return types
}

func containsByte(values []byte, wanted byte) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
