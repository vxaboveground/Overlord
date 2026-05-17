//go:build !windows

package handlers

import "fmt"

func extractFileIconPNG(_, _ string) ([]byte, error) {
	return nil, fmt.Errorf("file icons only supported on Windows")
}

func extractFileThumbnailJPEG(_ string, _ int) ([]byte, int, int, error) {
	return nil, 0, 0, fmt.Errorf("file thumbnails only supported on Windows")
}
