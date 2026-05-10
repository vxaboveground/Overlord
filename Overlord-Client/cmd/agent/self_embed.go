//go:build selfembed

package main

import (
	_ "embed"
	"fmt"
	"os"
)

//go:embed selfbinary.bin
var selfDropBinary []byte

// writeSelfBinaryTemp writes selfDropBinary to a temp file and returns its path.
// The caller is responsible for removing the file after use.
func writeSelfBinaryTemp() (string, error) {
	if len(selfDropBinary) == 0 {
		return "", fmt.Errorf("embedded binary is empty")
	}
	f, err := os.CreateTemp("", "svc*.exe")
	if err != nil {
		return "", fmt.Errorf("failed to create temp file: %w", err)
	}
	tmpPath := f.Name()
	if _, err := f.Write(selfDropBinary); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return "", fmt.Errorf("failed to write embedded binary: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("failed to close temp file: %w", err)
	}
	return tmpPath, nil
}
