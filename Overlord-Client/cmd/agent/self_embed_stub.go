//go:build !selfembed

package main

import "fmt"

// selfDropBinary is empty in normal builds. Set via //go:embed when compiled
// with -tags selfembed (two-pass Windows shellcode build).
var selfDropBinary []byte

func writeSelfBinaryTemp() (string, error) {
	return "", fmt.Errorf("not compiled with selfembed tag")
}
