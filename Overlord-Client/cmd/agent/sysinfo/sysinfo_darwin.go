//go:build darwin

package sysinfo

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

func collectPlatform() Info {
	percent, charging := batteryStatus()
	return Info{
		CPU:             cpuName(),
		GPU:             gpuName(),
		RAM:             totalRAM(),
		BatteryPercent:  percent,
		BatteryCharging: charging,
	}
}

func OSName() string {
	out, err := exec.Command("sw_vers", "-productVersion").Output()
	if err != nil {
		return "macOS"
	}
	version := strings.TrimSpace(string(out))
	if version == "" {
		return "macOS"
	}
	return "macOS " + version
}

func batteryStatus() (*int, bool) {
	out, err := exec.Command("pmset", "-g", "batt").Output()
	if err != nil {
		return nil, false
	}
	text := string(out)
	idx := strings.Index(text, "%")
	if idx <= 0 {
		return nil, false
	}
	start := idx - 1
	for start >= 0 && text[start] >= '0' && text[start] <= '9' {
		start--
	}
	var percent int
	if _, err := fmt.Sscanf(text[start+1:idx], "%d", &percent); err != nil {
		return nil, false
	}
	if percent < 0 || percent > 100 {
		return nil, false
	}
	lower := strings.ToLower(text)
	charging := strings.Contains(lower, "charging") || strings.Contains(lower, "charged")
	return &percent, charging
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
