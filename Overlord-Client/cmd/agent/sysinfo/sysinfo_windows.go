//go:build windows

package sysinfo

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
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
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE)
	if err != nil {
		return "Windows"
	}
	defer k.Close()

	product, _, _ := k.GetStringValue("ProductName")
	display, _, _ := k.GetStringValue("DisplayVersion")
	build, _, _ := k.GetStringValue("CurrentBuildNumber")

	name := strings.TrimSpace(product)
	if name == "" {
		name = "Windows"
	}
	var buildNumber int
	_, _ = fmt.Sscanf(strings.TrimSpace(build), "%d", &buildNumber)
	if buildNumber >= 22000 && !strings.Contains(name, "11") {
		name = strings.Replace(name, "Windows 10", "Windows 11", 1)
		if !strings.Contains(name, "11") {
			name = "Windows 11"
		}
	}
	if display = strings.TrimSpace(display); display != "" {
		name += " " + display
	}
	return name
}

func batteryStatus() (*int, bool) {
	type systemPowerStatus struct {
		ACLineStatus        byte
		BatteryFlag         byte
		BatteryLifePercent  byte
		SystemStatusFlag    byte
		BatteryLifeTime     uint32
		BatteryFullLifeTime uint32
	}

	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	getSystemPowerStatus := kernel32.NewProc("GetSystemPowerStatus")
	var status systemPowerStatus
	ret, _, _ := getSystemPowerStatus.Call(uintptr(unsafe.Pointer(&status)))
	if ret == 0 || status.BatteryLifePercent == 255 || status.BatteryFlag == 128 {
		return nil, false
	}
	percent := int(status.BatteryLifePercent)
	if percent < 0 || percent > 100 {
		return nil, false
	}
	return &percent, status.ACLineStatus == 1
}

func cpuName() string {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`HARDWARE\DESCRIPTION\System\CentralProcessor\0`, registry.QUERY_VALUE)
	if err != nil {
		return "unknown"
	}
	defer k.Close()
	name, _, err := k.GetStringValue("ProcessorNameString")
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(name)
}

func gpuName() string {
	basePath := `SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}`
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, basePath, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return "unknown"
	}
	defer k.Close()

	subkeys, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return "unknown"
	}

	var gpus []string
	for _, sub := range subkeys {
		if len(sub) != 4 {
			continue
		}
		allDigits := true
		for _, c := range sub {
			if c < '0' || c > '9' {
				allDigits = false
				break
			}
		}
		if !allDigits {
			continue
		}

		sk, err := registry.OpenKey(registry.LOCAL_MACHINE,
			basePath+`\`+sub, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		desc, _, err := sk.GetStringValue("DriverDesc")
		sk.Close()
		if err != nil || desc == "" {
			continue
		}
		gpus = append(gpus, strings.TrimSpace(desc))
	}

	if len(gpus) == 0 {
		return "unknown"
	}
	return strings.Join(gpus, ", ")
}

func totalRAM() string {
	type memoryStatusEx struct {
		Length               uint32
		MemoryLoad           uint32
		TotalPhys            uint64
		AvailPhys            uint64
		TotalPageFile        uint64
		AvailPageFile        uint64
		TotalVirtual         uint64
		AvailVirtual         uint64
		AvailExtendedVirtual uint64
	}

	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	globalMemoryStatusEx := kernel32.NewProc("GlobalMemoryStatusEx")

	var ms memoryStatusEx
	ms.Length = uint32(unsafe.Sizeof(ms))

	ret, _, _ := globalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&ms)))
	if ret == 0 {
		return "unknown"
	}

	gb := float64(ms.TotalPhys) / (1024 * 1024 * 1024)
	if gb >= 1 {
		return fmt.Sprintf("%.0f GB", gb)
	}
	mb := float64(ms.TotalPhys) / (1024 * 1024)
	return fmt.Sprintf("%.0f MB", mb)
}

func HostArch() string {
	if arch := os.Getenv("PROCESSOR_ARCHITEW6432"); arch != "" {
		switch strings.ToLower(arch) {
		case "amd64":
			return "amd64"
		case "arm64":
			return "arm64"
		}
	}
	if arch := os.Getenv("PROCESSOR_ARCHITECTURE"); arch != "" {
		switch strings.ToLower(arch) {
		case "amd64":
			return "amd64"
		case "arm64":
			return "arm64"
		case "x86":
			return "386"
		}
	}
	return runtime.GOARCH
}
