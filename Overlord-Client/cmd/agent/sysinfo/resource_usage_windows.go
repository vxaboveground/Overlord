//go:build windows

package sysinfo

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	cpuUsageOnce sync.Once
	cpuUsage     float64
	cpuLastIdle  uint64
	cpuLastTotal uint64
	cpuLastTime  time.Time
	cpuMu        sync.Mutex
)

// GetCPUUsage returns the current CPU usage percentage.
func GetCPUUsage() float64 {
	cpuUsageOnce.Do(func() {
		// Initialize with first reading
		idle, total := getSystemTimes()
		cpuLastIdle = idle
		cpuLastTotal = total
		cpuLastTime = time.Now()
	})

	cpuMu.Lock()
	defer cpuMu.Unlock()

	idle, total := getSystemTimes()
	now := time.Now()

	// Calculate delta
	idleDelta := idle - cpuLastIdle
	totalDelta := total - cpuLastTotal

	cpuLastIdle = idle
	cpuLastTotal = total
	cpuLastTime = now

	if totalDelta == 0 {
		return cpuUsage
	}

	cpuUsage = (1.0 - float64(idleDelta)/float64(totalDelta)) * 100.0
	return cpuUsage
}

func getSystemTimes() (idle, total uint64) {
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	getSystemTimes := kernel32.NewProc("GetSystemTimes")

	var idleTime, kernelTime, userTime windows.Filetime

	getSystemTimes.Call(
		uintptr(unsafe.Pointer(&idleTime)),
		uintptr(unsafe.Pointer(&kernelTime)),
		uintptr(unsafe.Pointer(&userTime)),
	)

	idle = uint64(idleTime.HighDateTime)<<32 | uint64(idleTime.LowDateTime)
	kernel := uint64(kernelTime.HighDateTime)<<32 | uint64(kernelTime.LowDateTime)
	user := uint64(userTime.HighDateTime)<<32 | uint64(userTime.LowDateTime)
	total = kernel + user

	return
}

// GetRAMUsage returns RAM usage percentage and used/total in bytes.
func GetRAMUsage() (usagePercent float64, usedBytes, totalBytes uint64) {
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
		return 0, 0, 0
	}

	usagePercent = float64(ms.MemoryLoad)
	totalBytes = ms.TotalPhys
	usedBytes = ms.TotalPhys - ms.AvailPhys

	return
}

// GetDiskUsage returns disk usage for the system drive (usually C:).
func GetDiskUsage() (usagePercent float64, usedBytes, totalBytes uint64) {
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	getDiskFreeSpaceEx := kernel32.NewProc("GetDiskFreeSpaceExW")

	var freeBytesAvailable, totalBytesOut, totalFree uint64

	ret, _, _ := getDiskFreeSpaceEx.Call(
		uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("C:\\"))),
		uintptr(unsafe.Pointer(&freeBytesAvailable)),
		uintptr(unsafe.Pointer(&totalBytesOut)),
		uintptr(unsafe.Pointer(&totalFree)),
	)

	if ret == 0 {
		return 0, 0, 0
	}

	totalBytes = totalBytesOut
	usedBytes = totalBytesOut - freeBytesAvailable
	if totalBytes > 0 {
		usagePercent = float64(usedBytes) / float64(totalBytes) * 100.0
	}

	return
}

// GetGPUUsage returns GPU usage percentage (best effort, may not work on all systems).
// Tries multiple methods in order of reliability.
func GetGPUUsage() float64 {
	// Method 1: typeperf (built-in Windows, most reliable)
	if usage := getGpuUsageTypePerf(); usage > 0 {
		return usage
	}

	// Method 2: PowerShell WMI query
	if usage := getGpuUsagePowerShell(); usage > 0 {
		return usage
	}

	return 0
}

func getGpuUsageTypePerf() float64 {
	// typeperf queries performance counters and returns formatted output
	// We query the GPU Engine utilization counter
	cmd := exec.Command("typeperf",
		`"\GPU Engine(*)\Utilization Percentage"`,
		"-sc", "2", // sample count: 2 (need 2 samples for delta)
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return 0
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) < 3 {
		return 0
	}

	// Last line has the format: "timestamp","value1","value2",...
	lastLine := lines[len(lines)-1]
	parts := strings.Split(lastLine, ",")
	if len(parts) < 2 {
		return 0
	}

	// Sum all GPU values (skip timestamp which is parts[0])
	var total float64
	for i := 1; i < len(parts); i++ {
		val := strings.Trim(parts[i], "\" ")
		var v float64
		if _, err := fmt.Sscanf(val, "%f", &v); err == nil {
			total += v
		}
	}

	if total > 100 {
		total = 100
	}
	return total
}

func getGpuUsagePowerShell() float64 {
	// Try Get-CimInstance first (modern PowerShell)
	cmd := exec.Command("powershell", "-NoProfile", "-Command",
		`try { $gpus = Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Namespace root/cimv2 -ErrorAction Stop; if ($gpus) { $total = 0; $count = 0; foreach ($gpu in $gpus) { $val = $gpu.UtilizationPercentage; if ($val -ne $null) { $total += [double]$val; $count++ } }; if ($count -gt 0) { [math]::Round($total / $count, 1) } else { 0 } } else { 0 } } catch { 0 }`)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return 0
	}
	s := strings.TrimSpace(string(out))
	var usage float64
	fmt.Sscanf(s, "%f", &usage)
	return usage
}

// ResourceUsage contains current system resource usage.
type ResourceUsage struct {
	CPUUsage  float64 `json:"cpu_usage" msgpack:"cpu_usage"`
	RAMUsage  float64 `json:"ram_usage" msgpack:"ram_usage"`
	RAMUsed   string  `json:"ram_used" msgpack:"ram_used"`
	RAMTotal  string  `json:"ram_total" msgpack:"ram_total"`
	DiskUsage float64 `json:"disk_usage" msgpack:"disk_usage"`
	DiskUsed  string  `json:"disk_used" msgpack:"disk_used"`
	DiskTotal string  `json:"disk_total" msgpack:"disk_total"`
	Uptime    string  `json:"uptime" msgpack:"uptime"`

	// Extended info (cross-platform)
	NetworkConnections []NetworkConnectionInfo `json:"network_connections" msgpack:"network_connections"`
	AllDrives          []DriveInfo             `json:"all_drives" msgpack:"all_drives"`
	EnvVars            map[string]string       `json:"env_vars" msgpack:"env_vars"`
	LoggedInUsers      []string                `json:"logged_in_users" msgpack:"logged_in_users"`
	Hostname           string                  `json:"hostname" msgpack:"hostname"`
	OSInfo             string                  `json:"os_info" msgpack:"os_info"`
	Arch               string                  `json:"arch" msgpack:"arch"`
	KernelVersion      string                  `json:"kernel_version" msgpack:"kernel_version"`

	// Windows-specific
	ScheduledTasks      []ScheduledTaskInfo       `json:"scheduled_tasks,omitempty" msgpack:"scheduled_tasks"`
	RegistryPersistence []RegistryPersistenceInfo `json:"registry_persistence,omitempty" msgpack:"registry_persistence"`
	RunningServices     []ServiceInfo             `json:"running_services,omitempty" msgpack:"running_services"`
	StartupPrograms     []StartupProgramInfo      `json:"startup_programs,omitempty" msgpack:"startup_programs"`
	AntivirusProducts   []string                  `json:"antivirus_products,omitempty" msgpack:"antivirus_products"`

	// Linux-specific
	CronJobs      []CronJobInfo `json:"cron_jobs,omitempty" msgpack:"cron_jobs"`
	SystemdUnits  []UnitInfo    `json:"systemd_units,omitempty" msgpack:"systemd_units"`
	InstalledPkgs []string      `json:"installed_packages,omitempty" msgpack:"installed_packages"`

	// macOS-specific
	LaunchAgents  []LaunchItemInfo `json:"launch_agents,omitempty" msgpack:"launch_agents"`
	LaunchDaemons []LaunchItemInfo `json:"launch_daemons,omitempty" msgpack:"launch_daemons"`

	// WiFi credentials (cross-platform)
	WiFiProfiles []WiFiProfileInfo `json:"wifi_profiles,omitempty" msgpack:"wifi_profiles"`
}

// NetworkConnectionInfo represents an active network connection.
type NetworkConnectionInfo struct {
	Protocol    string `json:"protocol" msgpack:"protocol"`
	LocalAddr   string `json:"local_addr" msgpack:"local_addr"`
	RemoteAddr  string `json:"remote_addr" msgpack:"remote_addr"`
	State       string `json:"state" msgpack:"state"`
	PID         uint32 `json:"pid" msgpack:"pid"`
	ProcessName string `json:"process_name" msgpack:"process_name"`
}

// DriveInfo represents a drive/mount's usage.
type DriveInfo struct {
	Mount string  `json:"mount" msgpack:"mount"`
	Label string  `json:"label" msgpack:"label"`
	Type  string  `json:"type" msgpack:"type"`
	Usage float64 `json:"usage" msgpack:"usage"`
	Used  string  `json:"used" msgpack:"used"`
	Total string  `json:"total" msgpack:"total"`
	FS    string  `json:"fs" msgpack:"fs"`
}

// ScheduledTaskInfo represents a non-Microsoft scheduled task (Windows).
type ScheduledTaskInfo struct {
	Name    string `json:"name" msgpack:"name"`
	Path    string `json:"path" msgpack:"path"`
	State   string `json:"state" msgpack:"state"`
	NextRun string `json:"next_run" msgpack:"next_run"`
	Author  string `json:"author" msgpack:"author"`
	Command string `json:"command" msgpack:"command"`
}

// RegistryPersistenceInfo represents a registry-based persistence entry (Windows).
type RegistryPersistenceInfo struct {
	Key   string `json:"key" msgpack:"key"`
	Name  string `json:"name" msgpack:"name"`
	Value string `json:"value" msgpack:"value"`
	Type  string `json:"type" msgpack:"type"`
}

// ServiceInfo represents a running Windows service.
type ServiceInfo struct {
	Name        string `json:"name" msgpack:"name"`
	DisplayName string `json:"display_name" msgpack:"display_name"`
	State       string `json:"state" msgpack:"state"`
	StartMode   string `json:"start_mode" msgpack:"start_mode"`
	PathName    string `json:"path_name" msgpack:"path_name"`
}

// StartupProgramInfo represents a startup program entry (Windows).
type StartupProgramInfo struct {
	Name     string `json:"name" msgpack:"name"`
	Path     string `json:"path" msgpack:"path"`
	Location string `json:"location" msgpack:"location"`
}

// CronJobInfo represents a cron job entry (Linux/macOS).
type CronJobInfo struct {
	User     string `json:"user" msgpack:"user"`
	Command  string `json:"command" msgpack:"command"`
	Schedule string `json:"schedule" msgpack:"schedule"`
	File     string `json:"file" msgpack:"file"`
}

// UnitInfo represents a systemd unit (Linux).
type UnitInfo struct {
	Name        string `json:"name" msgpack:"name"`
	Description string `json:"description" msgpack:"description"`
	LoadState   string `json:"load_state" msgpack:"load_state"`
	ActiveState string `json:"active_state" msgpack:"active_state"`
	SubState    string `json:"sub_state" msgpack:"sub_state"`
}

// LaunchItemInfo represents a launchd agent/daemon (macOS).
type LaunchItemInfo struct {
	Label     string `json:"label" msgpack:"label"`
	Program   string `json:"program" msgpack:"program"`
	RunAtLoad bool   `json:"run_at_load" msgpack:"run_at_load"`
	KeepAlive bool   `json:"keep_alive" msgpack:"keep_alive"`
	Disabled  bool   `json:"disabled" msgpack:"disabled"`
	Location  string `json:"location" msgpack:"location"`
}

// WiFiProfileInfo represents a saved WiFi network with credentials.
type WiFiProfileInfo struct {
	SSID     string `json:"ssid" msgpack:"ssid"`
	Password string `json:"password" msgpack:"password"`
	Security string `json:"security" msgpack:"security"`
}

// GetResourceUsage collects all resource usage data.
func GetResourceUsage() ResourceUsage {
	cpuUsage := GetCPUUsage()
	ramPercent, ramUsed, ramTotal := GetRAMUsage()
	diskPercent, diskUsed, diskTotal := GetDiskUsage()

	// Get uptime
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	getTickCount64 := kernel32.NewProc("GetTickCount64")
	ticks, _, _ := getTickCount64.Call()
	uptime := time.Duration(ticks) * time.Millisecond

	hostname, _ := os.Hostname()

	// Run all expensive collection calls in parallel
	var wg sync.WaitGroup

	var netConns []NetworkConnectionInfo
	var envVars map[string]string
	var loggedUsers []string
	var schedTasks []ScheduledTaskInfo
	var regPersist []RegistryPersistenceInfo
	var runServices []ServiceInfo
	var startupProgs []StartupProgramInfo
	var avProducts []string
	var wifiProfiles []WiFiProfileInfo

	wg.Add(9)
	go func() { defer wg.Done(); netConns = GetNetworkConnections() }()
	go func() { defer wg.Done(); envVars = GetInterestingEnvVars() }()
	go func() { defer wg.Done(); loggedUsers = GetLoggedInUsers() }()
	go func() { defer wg.Done(); schedTasks = GetScheduledTasks() }()
	go func() { defer wg.Done(); regPersist = GetRegistryPersistence() }()
	go func() { defer wg.Done(); runServices = GetRunningServices() }()
	go func() { defer wg.Done(); startupProgs = GetStartupPrograms() }()
	go func() { defer wg.Done(); avProducts = GetAntivirusProducts() }()
	go func() { defer wg.Done(); wifiProfiles = GetWiFiProfiles() }()

	wg.Wait()

	return ResourceUsage{
		CPUUsage:  cpuUsage,
		RAMUsage:  ramPercent,
		RAMUsed:   FormatBytes(ramUsed),
		RAMTotal:  FormatBytes(ramTotal),
		DiskUsage: diskPercent,
		DiskUsed:  FormatBytes(diskUsed),
		DiskTotal: FormatBytes(diskTotal),
		Uptime:    formatDuration(uptime),

		Hostname:            hostname,
		OSInfo:              getOSInfoWindows(),
		Arch:                runtime.GOARCH,
		KernelVersion:       getKernelVersionWindows(),
		NetworkConnections:  netConns,
		AllDrives:           GetAllDrives(),
		EnvVars:             envVars,
		LoggedInUsers:       loggedUsers,
		ScheduledTasks:      schedTasks,
		RegistryPersistence: regPersist,
		RunningServices:     runServices,
		StartupPrograms:     startupProgs,
		AntivirusProducts:   avProducts,
		WiFiProfiles:        wifiProfiles,
	}
}

func formatDuration(d time.Duration) string {
	d = d.Round(time.Second)
	days := d / (24 * time.Hour)
	d -= days * 24 * time.Hour
	hours := d / time.Hour
	d -= hours * time.Hour
	minutes := d / time.Minute
	d -= minutes * time.Minute
	seconds := d / time.Second

	if days > 0 {
		return fmt.Sprintf("%dd %dh %dm", days, hours, minutes)
	}
	return fmt.Sprintf("%dh %dm %ds", hours, minutes, seconds)
}

func getOSInfoWindows() string {
	cmd := exec.Command("cmd", "/c", "ver")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return "Windows"
	}
	return strings.TrimSpace(string(out))
}

func getKernelVersionWindows() string {
	cmd := exec.Command("powershell", "-NoProfile", "-Command", "[System.Environment]::OSVersion.Version.ToString()")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
