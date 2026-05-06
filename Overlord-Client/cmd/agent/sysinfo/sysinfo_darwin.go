//go:build darwin

package sysinfo

import (
	"fmt"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

func collectPlatform() Info {
	return Info{
		CPU: cpuName(),
		GPU: gpuName(),
		RAM: totalRAM(),
	}
}

func cpuName() string {
	name, err := unix.Sysctl("machdep.cpu.brand_string")
	if err != nil || name == "" {
		return "unknown"
	}
	return strings.TrimSpace(name)
}

func gpuName() string {
	return "unknown"
}

func totalRAM() string {
	mem, err := unix.SysctlRaw("hw.memsize")
	if err != nil || len(mem) < 8 {
		return "unknown"
	}
	total := *(*uint64)(unsafe.Pointer(&mem[0]))
	gb := float64(total) / (1024 * 1024 * 1024)
	if gb >= 1 {
		return fmt.Sprintf("%.0f GB", gb)
	}
	mb := float64(total) / (1024 * 1024)
	return fmt.Sprintf("%.0f MB", mb)
}

func HostArch() string {
	if machine, err := unix.Sysctl("hw.machine"); err == nil {
		switch machine {
		case "x86_64":
			return "amd64"
		case "arm64":
			return "arm64"
		}
	}
	return runtime.GOARCH
}
