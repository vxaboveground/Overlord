//go:build shellcode_console

package main

import (
	"log"
	"os"
	"syscall"
)

func init() {
	k32 := syscall.NewLazyDLL("kernel32.dll")

	// Try to attach to the loader's existing console first.
	// If that fails (GUI loader or FreeConsole was called), create a new one.
	r, _, _ := k32.NewProc("AttachConsole").Call(^uintptr(0)) // ATTACH_PARENT_PROCESS
	if r == 0 {
		k32.NewProc("AllocConsole").Call()
	}

	// Open the Windows console output device and redirect Go's stderr + log
	// so that log.Printf output is visible regardless of how handles were inherited.
	conout, err := syscall.Open("CONOUT$", syscall.O_RDWR, 0)
	if err == nil {
		w := os.NewFile(uintptr(conout), "stderr")
		os.Stderr = w
		log.SetOutput(w)
	}
}
