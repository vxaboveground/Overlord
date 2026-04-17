//go:build windows

package sysinfo

import (
	"bufio"
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
	var localIP, defaultGateway string
	var dnsServers []string
	var mappedDrives []MappedDriveInfo
	var psHistory string

	wg.Add(12)
	go func() { defer wg.Done(); netConns = GetNetworkConnections() }()
	go func() { defer wg.Done(); envVars = GetInterestingEnvVars() }()
	go func() { defer wg.Done(); loggedUsers = GetLoggedInUsers() }()
	go func() { defer wg.Done(); schedTasks = GetScheduledTasks() }()
	go func() { defer wg.Done(); regPersist = GetRegistryPersistence() }()
	go func() { defer wg.Done(); runServices = GetRunningServices() }()
	go func() { defer wg.Done(); startupProgs = GetStartupPrograms() }()
	go func() { defer wg.Done(); avProducts = GetAntivirusProducts() }()
	go func() { defer wg.Done(); wifiProfiles = GetWiFiProfiles() }()
	go func() {
		defer wg.Done()
		localIP, defaultGateway, dnsServers = parseIPConfig()
	}()
	go func() { defer wg.Done(); mappedDrives = GetMappedDrives() }()
	go func() { defer wg.Done(); psHistory = GetPSHistory() }()

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

		LocalIP:        localIP,
		DefaultGateway: defaultGateway,
		DNSServers:     dnsServers,
		MappedDrives:   mappedDrives,
		PSHistory:      psHistory,
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

// parseIPConfig runs `ipconfig /all` once and parses it section-by-section.
// It selects the best physical Ethernet adapter (skipping VPN, VMware, virtual adapters)
// and returns its local IP, gateway, and DNS servers.
func parseIPConfig() (localIP, gateway string, dns []string) {
	cmd := exec.Command("ipconfig", "/all")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return
	}

	type adapterSection struct {
		header  string
		ip      string
		gateway string
		dns     []string
		// higher = better
		score int
	}

	var sections []adapterSection
	var cur *adapterSection
	var inDNS bool
	var seenDNS map[string]bool

	adapterScore := func(header string) int {
		h := strings.ToLower(header)
		// Reject clearly virtual/VPN adapters
		if strings.Contains(h, "vmware") || strings.Contains(h, "vethernet") ||
			strings.Contains(h, "hyper-v") || strings.Contains(h, "wsl") ||
			strings.Contains(h, "virtualbox") || strings.Contains(h, "loopback") ||
			strings.Contains(h, "mullvad") || strings.Contains(h, "wireguard") ||
			strings.Contains(h, "nordvpn") || strings.Contains(h, "expressvpn") ||
			strings.Contains(h, "tunnel") || strings.Contains(h, "vpn") ||
			strings.Contains(h, "teredo") || strings.Contains(h, "isatap") {
			return 0
		}
		// Real Ethernet adapters score highest
		if strings.HasPrefix(h, "ethernet adapter") {
			return 3
		}
		// Wi-Fi second
		if strings.HasPrefix(h, "wireless lan adapter") || strings.Contains(h, "wi-fi") || strings.Contains(h, "wlan") {
			return 2
		}
		// Unknown adapter (could be VPN or real) — low priority
		if strings.HasPrefix(h, "unknown adapter") {
			return 0
		}
		return 1
	}

	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)

		// Adapter header lines have no leading whitespace and end with ':'
		if !strings.HasPrefix(line, " ") && strings.HasSuffix(trimmed, ":") && (strings.Contains(trimmed, "adapter") || strings.Contains(trimmed, "Adapter")) {
			if cur != nil {
				sections = append(sections, *cur)
			}
			header := strings.TrimSuffix(trimmed, ":")
			cur = &adapterSection{
				header: header,
				score:  adapterScore(header),
			}
			seenDNS = make(map[string]bool)
			inDNS = false
			continue
		}

		if cur == nil {
			continue
		}

		// IPv4 Address
		if cur.ip == "" && strings.Contains(line, "IPv4 Address") {
			if idx := strings.Index(line, ":"); idx >= 0 {
				ip := strings.TrimSpace(line[idx+1:])
				// Strip trailing "(Preferred)" with any surrounding whitespace
				if i := strings.Index(ip, "("); i >= 0 {
					ip = strings.TrimSpace(ip[:i])
				}
				if ip != "" && !strings.HasPrefix(ip, "127.") && !strings.HasPrefix(ip, "169.254.") {
					cur.ip = ip
				}
			}
			inDNS = false
			continue
		}

		// Default Gateway
		if cur.gateway == "" && strings.Contains(line, "Default Gateway") {
			if idx := strings.Index(line, ":"); idx >= 0 {
				gw := strings.TrimSpace(line[idx+1:])
				if gw != "" && !strings.HasPrefix(gw, "fe80") {
					cur.gateway = gw
				}
			}
			inDNS = false
			continue
		}

		// DNS Servers
		if strings.Contains(line, "DNS Servers") {
			if idx := strings.Index(line, ":"); idx >= 0 {
				ip := strings.TrimSpace(line[idx+1:])
				if ip != "" && !seenDNS[ip] && !strings.HasPrefix(ip, "fe80") {
					cur.dns = append(cur.dns, ip)
					seenDNS[ip] = true
				}
			}
			inDNS = true
			continue
		}

		// DNS continuation (indented lines after "DNS Servers")
		if inDNS {
			if strings.HasPrefix(line, "   ") && trimmed != "" && !strings.Contains(trimmed, ":") && strings.Contains(trimmed, ".") {
				if !seenDNS[trimmed] && !strings.HasPrefix(trimmed, "fe80") {
					cur.dns = append(cur.dns, trimmed)
					seenDNS[trimmed] = true
				}
			} else if trimmed != "" {
				inDNS = false
			}
		}
	}

	if cur != nil {
		sections = append(sections, *cur)
	}

	// Select best adapter: highest score, tie-break on having a gateway
	var best *adapterSection
	for i := range sections {
		s := &sections[i]
		if s.ip == "" || s.score == 0 {
			continue
		}
		if best == nil {
			best = s
			continue
		}
		// Prefer higher score; on equal score prefer the one with a gateway
		if s.score > best.score || (s.score == best.score && s.gateway != "" && best.gateway == "") {
			best = s
		}
	}

	if best != nil {
		localIP = best.ip
		gateway = best.gateway
		dns = best.dns
	}
	return
}

// GetLocalIP — thin wrapper kept for compatibility.
func GetLocalIP() string {
	ip, _, _ := parseIPConfig()
	return ip
}

// GetDefaultGateway — thin wrapper kept for compatibility.
func GetDefaultGateway() string {
	_, gw, _ := parseIPConfig()
	return gw
}

// GetDNSServers — thin wrapper kept for compatibility.
func GetDNSServers() []string {
	_, _, dns := parseIPConfig()
	return dns
}

// GetMappedDrives returns mapped network drives using net use.
func GetMappedDrives() []MappedDriveInfo {
	cmd := exec.Command("net", "use")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var drives []MappedDriveInfo
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "-") || strings.HasPrefix(line, "New") || strings.HasPrefix(line, "The command") {
			continue
		}
		fields := strings.Fields(line)
		// Expect: Status  Drive  Path  e.g. "OK  Z:  \\server\share"
		// or "Disconnected  Z:  \\server\share"
		if len(fields) >= 3 {
			status := fields[0]
			letter := fields[1]
			path := fields[2]
			if strings.HasSuffix(letter, ":") && strings.HasPrefix(path, `\\`) {
				drives = append(drives, MappedDriveInfo{
					Letter: letter,
					Path:   path,
					Status: status,
				})
			}
		}
	}
	return drives
}

// GetPSHistory reads PowerShell ConsoleHost_history.txt for the current user.
// Tries multiple path resolution strategies to ensure it works in all agent contexts.
func GetPSHistory() string {
	// Build candidate paths using multiple env var / API fallbacks
	var candidates []string

	// Method 1: APPDATA env var (most direct)
	if appData := os.Getenv("APPDATA"); appData != "" {
		candidates = append(candidates,
			appData+`\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`,
		)
	}

	// Method 2: USERPROFILE + Roaming subpath
	if userProfile := os.Getenv("USERPROFILE"); userProfile != "" {
		candidates = append(candidates,
			userProfile+`\AppData\Roaming\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`,
		)
	}

	// Method 3: os.UserHomeDir() — works even if env vars stripped out
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates,
			home+`\AppData\Roaming\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`,
		)
	}

	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil || len(data) == 0 {
			continue
		}
		content := strings.TrimSpace(string(data))
		// Limit to last 200 lines to avoid huge payloads
		lines := strings.Split(content, "\n")
		if len(lines) > 200 {
			lines = lines[len(lines)-200:]
		}
		return strings.Join(lines, "\n")
	}
	return ""
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
