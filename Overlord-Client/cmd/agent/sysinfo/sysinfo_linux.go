//go:build linux

package sysinfo

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"syscall"
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
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "Linux"
	}
	values := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		values[parts[0]] = strings.Trim(strings.TrimSpace(parts[1]), `"`)
	}
	if pretty := strings.TrimSpace(values["PRETTY_NAME"]); pretty != "" {
		return pretty
	}
	if name := strings.TrimSpace(values["NAME"]); name != "" {
		if version := strings.TrimSpace(values["VERSION_ID"]); version != "" {
			return name + " " + version
		}
		return name
	}
	return "Linux"
}

func batteryStatus() (*int, bool) {
	entries, err := os.ReadDir("/sys/class/power_supply")
	if err != nil {
		return nil, false
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "BAT") {
			continue
		}
		base := "/sys/class/power_supply/" + entry.Name()
		capacityRaw, err := os.ReadFile(base + "/capacity")
		if err != nil {
			continue
		}
		var percent int
		if _, err := fmt.Sscanf(strings.TrimSpace(string(capacityRaw)), "%d", &percent); err != nil {
			continue
		}
		if percent < 0 || percent > 100 {
			continue
		}
		statusRaw, _ := os.ReadFile(base + "/status")
		status := strings.ToLower(strings.TrimSpace(string(statusRaw)))
		charging := status == "charging" || status == "full"
		return &percent, charging
	}
	return nil, false
}

func cpuName() string {
	data, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return "unknown"
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "model name") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
	}
	return "unknown"
}

func gpuName() string {
	entries, err := os.ReadDir("/sys/class/drm")
	if err != nil {
		return "unknown"
	}
	var gpus []string
	seen := map[string]bool{}
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), "card") || strings.Contains(e.Name(), "-") {
			continue
		}
		labelPath := "/sys/class/drm/" + e.Name() + "/device/label"
		if data, err := os.ReadFile(labelPath); err == nil {
			name := strings.TrimSpace(string(data))
			if name != "" && !seen[name] {
				seen[name] = true
				gpus = append(gpus, name)
				continue
			}
		}

		ueventPath := "/sys/class/drm/" + e.Name() + "/device/uevent"
		if data, err := os.ReadFile(ueventPath); err == nil {
			for _, line := range strings.Split(string(data), "\n") {
				if strings.HasPrefix(line, "DRIVER=") {
					drv := strings.TrimPrefix(line, "DRIVER=")
					if drv != "" && !seen[drv] {
						seen[drv] = true
						gpus = append(gpus, drv)
					}
				}
			}
		}
	}
	if len(gpus) == 0 {
		return "unknown"
	}
	return strings.Join(gpus, ", ")
}

func totalRAM() string {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return "unknown"
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				var kb uint64
				_, err := fmt.Sscanf(fields[1], "%d", &kb)
				if err != nil {
					return "unknown"
				}
				gb := float64(kb) / (1024 * 1024)
				if gb >= 1 {
					return fmt.Sprintf("%.0f GB", gb)
				}
				mb := float64(kb) / 1024
				return fmt.Sprintf("%.0f MB", mb)
			}
		}
	}
	return "unknown"
}

func HostArch() string {
	var utsname syscall.Utsname
	if err := syscall.Uname(&utsname); err == nil {
		buf := make([]byte, 0, len(utsname.Machine))
		for _, c := range utsname.Machine {
			if c == 0 {
				break
			}
			buf = append(buf, byte(c))
		}
		machine := string(buf)
		switch machine {
		case "x86_64":
			return "amd64"
		case "aarch64":
			return "arm64"
		case "armv7l":
			return "armv7"
		case "i686", "i386":
			return "386"
		}
	}
	return runtime.GOARCH
}
