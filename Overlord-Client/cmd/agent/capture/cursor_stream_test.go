package capture

import (
	"image"
	"testing"
)

func TestCursorShapeRefreshesWhenEncodedResolutionChanges(t *testing.T) {
	cursor := DesktopCursorMetadata{Enabled: true, Shape: 7, Generation: 3}
	previous := desktopCursorStreamState{
		enabled: true, shape: 7, generation: 3,
		width: 3840, height: 2160,
	}

	if !cursorShapeNeedsRefresh(cursor, previous, 1920, 1080) {
		t.Fatal("cursor shape metadata was not refreshed for 4K to 1080p change")
	}
	if cursorShapeNeedsRefresh(cursor, previous, 3840, 2160) {
		t.Fatal("unchanged encoded resolution refreshed cursor shape metadata")
	}
}

func TestEmptyDirectFrameKeepsEncodedCursorResolution(t *testing.T) {
	previous := desktopCursorStreamState{width: 1920, height: 1080}
	width, height := resolveCursorFrameSize(0, 0, previous, image.Rect(0, 0, 3840, 2160))
	if width != 1920 || height != 1080 {
		t.Fatalf("empty frame cursor size = %dx%d, want 1920x1080", width, height)
	}
	cursor := DesktopCursorMetadata{Enabled: true, Shape: 7, Generation: 3}
	previous.enabled, previous.shape, previous.generation = true, 7, 3
	if cursorShapeNeedsRefresh(cursor, previous, width, height) {
		t.Fatal("empty direct frame caused a redundant cursor PNG refresh")
	}
}
