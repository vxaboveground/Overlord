package handlers

import (
	"encoding/binary"
	"testing"
)

func TestDesktopAudioLegacyPCMDownmixesAndDecimates(t *testing.T) {
	// Three 48 kHz stereo frames become one 16 kHz mono sample. Stereo frame
	// means are 2000, 4000, and 6000; their anti-aliasing mean is 4000.
	input := make([]byte, 0, 12)
	for _, pair := range [][2]int16{{1000, 3000}, {3000, 5000}, {5000, 7000}} {
		input = binary.LittleEndian.AppendUint16(input, uint16(pair[0]))
		input = binary.LittleEndian.AppendUint16(input, uint16(pair[1]))
	}
	converter := &desktopAudioLegacyConverter{}
	if out := converter.Convert(input[:5]); len(out) != 0 {
		t.Fatalf("fragment produced %d bytes before a complete window", len(out))
	}
	out := converter.Convert(input[5:])
	if len(out) != 2 {
		t.Fatalf("legacy PCM length = %d, want 2", len(out))
	}
	if got := int16(binary.LittleEndian.Uint16(out)); got != 4000 {
		t.Fatalf("legacy PCM sample = %d, want 4000", got)
	}
}
