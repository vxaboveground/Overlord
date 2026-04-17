//go:build windows && amd64

package teb

// CurrentTEB returns the address of the current thread's Thread Environment Block.
func CurrentTEB() uintptr
