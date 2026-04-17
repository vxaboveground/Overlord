//go:build darwin

package sysinfo

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
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
		idle, total := getCPUsageDarwin()
		cpuLastIdle = idle
		cpuLastTotal = total
		cpuLastTime = time.Now()
	})

	cpuMu.Lock()
	defer cpuMu.Unlock()

	idle, total := getCPUsageDarwin()
	now := time.Now()

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

func getCPUsageDarwin() (idle, total uint64) {
	cmd := exec.Command("ps", "-A", "-o", "time=")
	out, err := cmd.Output()
	if err != nil {
		return 0, 1
	}

	// Count total CPU time used (rough approximation)
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		// Parse time like "0:00.01" or "1:23.45"
		parts := strings.Split(line, ":")
		if len(parts) >= 2 {
			mins, _ := strconv.ParseUint(parts[0], 10, 64)
			secParts := strings.Split(parts[1], ".")
			secs, _ := strconv.ParseUint(secParts[0], 10, 64)
			total += mins*60 + secs
		}
	}

	// Get idle from vm_stat
	cmd = exec.Command("vm_stat")
	out, err = cmd.Output()
	if err != nil {
		return 0, total
	}

	scanner = bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, "Pages free") || strings.Contains(line, "Pages speculative") {
			re := regexp.MustCompile(`[\d.]+`)
			if m := re.FindString(line); m != "" {
				pages, _ := strconv.ParseUint(m, 10, 64)
				idle += pages
			}
		}
	}

	if total == 0 {
		total = 1
	}
	return
}

// GetRAMUsage returns RAM usage percentage and used/total in bytes.
func GetRAMUsage() (usagePercent float64, usedBytes, totalBytes uint64) {
	// Get total physical memory
	cmd := exec.Command("sysctl", "-n", "hw.memsize")
	out, err := cmd.Output()
	if err != nil {
		return 0, 0, 0
	}
	totalBytes, _ = strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)

	// Get memory pressure / used
	cmd = exec.Command("vm_stat")
	out, err = cmd.Output()
	if err != nil {
		return 0, 0, totalBytes
	}

	// Parse vm_stat output
	pageSize := uint64(4096) // Default macOS page size
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	var pagesActive, pagesWired uint64

	for scanner.Scan() {
		line := scanner.Text()
		re := regexp.MustCompile(`[\d.]+`)
		m := re.FindString(line)
		if m == "" {
			continue
		}
		pages, _ := strconv.ParseUint(m, 10, 64)

		if strings.Contains(line, "Pages active") {
			pagesActive = pages
		} else if strings.Contains(line, "Pages wired down") {
			pagesWired = pages
		}
	}

	usedBytes = (pagesActive + pagesWired) * pageSize
	if totalBytes > 0 {
		usagePercent = float64(usedBytes) / float64(totalBytes) * 100.0
	}

	return
}

// GetDiskUsage returns disk usage for the root filesystem.
func GetDiskUsage() (usagePercent float64, usedBytes, totalBytes uint64) {
	var stat syscall.Statfs_t
	err := syscall.Statfs("/", &stat)
	if err != nil {
		return 0, 0, 0
	}

	totalBytes = stat.Blocks * uint64(stat.Bsize)
	freeBytes := stat.Bavail * uint64(stat.Bsize)
	usedBytes = totalBytes - freeBytes

	if totalBytes > 0 {
		usagePercent = float64(usedBytes) / float64(totalBytes) * 100.0
	}
	return
}

// GetResourceUsage collects all resource usage data.
func GetResourceUsage() ResourceUsage {
	cpuUsage := GetCPUUsage()
	ramPercent, ramUsed, ramTotal := GetRAMUsage()
	diskPercent, diskUsed, diskTotal := GetDiskUsage()

	uptime := getUptimeDarwin()
	hostname, _ := os.Hostname()

	return ResourceUsage{
		CPUUsage:  cpuUsage,
		RAMUsage:  ramPercent,
		RAMUsed:   FormatBytes(ramUsed),
		RAMTotal:  FormatBytes(ramTotal),
		DiskUsage: diskPercent,
		DiskUsed:  FormatBytes(diskUsed),
		DiskTotal: FormatBytes(diskTotal),
		Uptime:    formatDuration(uptime),

		Hostname:           hostname,
		OSInfo:             getOSInfoDarwin(),
		Arch:               getArchDarwin(),
		KernelVersion:      getKernelVersionDarwin(),
		NetworkConnections: GetNetworkConnectionsDarwin(),
		AllDrives:          GetAllDrivesDarwin(),
		EnvVars:            GetInterestingEnvVarsDarwin(),
		LoggedInUsers:      GetLoggedInUsersDarwin(),
		CronJobs:           GetCronJobsDarwin(),
		LaunchAgents:       GetLaunchAgents(),
		LaunchDaemons:      GetLaunchDaemons(),
		WiFiProfiles:       GetWiFiProfilesDarwin(),

		LocalIP:        GetLocalIPDarwin(),
		DefaultGateway: GetDefaultGatewayDarwin(),
		DNSServers:     GetDNSServersDarwin(),
		MappedDrives:   GetMappedDrivesDarwin(),
		PSHistory:      GetPSHistoryDarwin(),
	}
}

// GetLocalIPDarwin returns the primary local IP via route get.
func GetLocalIPDarwin() string {
	// route get default gives us the interface, then ipconfig getifaddr
	out, err := exec.Command("route", "get", "default").Output()
	if err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "interface:") {
				iface := strings.TrimSpace(strings.TrimPrefix(line, "interface:"))
				out2, err2 := exec.Command("ipconfig", "getifaddr", iface).Output()
				if err2 == nil {
					ip := strings.TrimSpace(string(out2))
					if ip != "" {
						return ip
					}
				}
			}
		}
	}
	return ""
}

// GetDefaultGatewayDarwin returns the default gateway via route.
func GetDefaultGatewayDarwin() string {
	out, err := exec.Command("route", "-n", "get", "default").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "gateway:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "gateway:"))
		}
	}
	return ""
}

// GetDNSServersDarwin returns DNS servers from scutil --dns.
func GetDNSServersDarwin() []string {
	out, err := exec.Command("scutil", "--dns").Output()
	if err != nil {
		// Fallback: resolv.conf
		data, err2 := os.ReadFile("/etc/resolv.conf")
		if err2 != nil {
			return nil
		}
		var servers []string
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "nameserver ") {
				ip := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "nameserver "))
				if ip != "" {
					servers = append(servers, ip)
				}
			}
		}
		return servers
	}
	seen := make(map[string]bool)
	var servers []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "nameserver[") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				ip := strings.TrimSpace(parts[1])
				if ip != "" && !seen[ip] {
					servers = append(servers, ip)
					seen[ip] = true
				}
			}
		}
	}
	return servers
}

// GetMappedDrivesDarwin returns SMB/AFP mounts on macOS.
func GetMappedDrivesDarwin() []MappedDriveInfo {
	out, err := exec.Command("mount").Output()
	if err != nil {
		return nil
	}
	var drives []MappedDriveInfo
	for _, line := range strings.Split(string(out), "\n") {
		// SMB: //user@server/share on /Volumes/share (smbfs, ...)
		// AFP: afp://server/share on /Volumes/share (afpfs, ...)
		if strings.Contains(line, "smbfs") || strings.Contains(line, "afpfs") || strings.Contains(line, "nfs") {
			parts := strings.SplitN(line, " on ", 2)
			if len(parts) == 2 {
				unc := strings.TrimSpace(parts[0])
				rest := strings.TrimSpace(parts[1])
				mountPt := strings.Fields(rest)[0]
				drives = append(drives, MappedDriveInfo{
					Letter: mountPt,
					Path:   unc,
					Status: "Mounted",
				})
			}
		}
	}
	return drives
}

// GetPSHistoryDarwin reads shell history for the current user (bash/zsh).
func GetPSHistoryDarwin() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	candidates := []string{
		home + "/.zsh_history",
		home + "/.bash_history",
		home + "/.local/share/fish/fish_history",
	}
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		content := strings.TrimSpace(string(data))
		lines := strings.Split(content, "\n")
		if len(lines) > 200 {
			lines = lines[len(lines)-200:]
		}
		return strings.Join(lines, "\n")
	}
	return ""
}

func getUptimeDarwin() time.Duration {
	cmd := exec.Command("sysctl", "-n", "kern.boottime")
	out, err := cmd.Output()
	if err != nil {
		return 0
	}

	// Parse "sec = 1234567890, usec = 123456"
	re := regexp.MustCompile(`sec\s*=\s*(\d+)`)
	m := re.FindStringSubmatch(string(out))
	if len(m) < 2 {
		return 0
	}
	bootTime, _ := strconv.ParseInt(m[1], 10, 64)
	now := time.Now().Unix()
	return time.Duration(now-bootTime) * time.Second
}

func getOSInfoDarwin() string {
	cmd := exec.Command("sw_vers", "-productVersion")
	out, _ := cmd.Output()
	ver := strings.TrimSpace(string(out))
	cmd = exec.Command("sw_vers", "-productName")
	name, _ := cmd.Output()
	return strings.TrimSpace(string(name)) + " " + ver
}

func getArchDarwin() string {
	out, _ := exec.Command("uname", "-m").Output()
	return strings.TrimSpace(string(out))
}

func getKernelVersionDarwin() string {
	out, _ := exec.Command("uname", "-r").Output()
	return strings.TrimSpace(string(out))
}

// GetNetworkConnectionsDarwin returns active network connections.
func GetNetworkConnectionsDarwin() []NetworkConnectionInfo {
	cmd := exec.Command("lsof", "-i", "-nP")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	var conns []NetworkConnectionInfo
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	header := true
	count := 0
	for scanner.Scan() && count < 100 {
		line := strings.TrimSpace(scanner.Text())
		if header {
			header = false
			continue
		}
		if line == "" {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 9 {
			continue
		}

		procName := fields[0]
		pidStr := fields[1]
		pid, _ := strconv.ParseUint(pidStr, 10, 32)

		// Type field (IPv4/IPv6)
		// Name field contains address info
		nameField := fields[8]
		proto := "TCP"
		if strings.Contains(nameField, "(UDP)") {
			proto = "UDP"
			nameField = strings.TrimSuffix(nameField, " (UDP)")
		} else if strings.Contains(nameField, "(ESTABLISHED)") {
			nameField = strings.TrimSuffix(nameField, " (ESTABLISHED)")
		} else if strings.Contains(nameField, "(LISTEN)") {
			nameField = strings.TrimSuffix(nameField, " (LISTEN)")
		}

		parts := strings.Split(nameField, "->")
		localAddr := ""
		remoteAddr := ""
		state := ""

		if len(parts) == 2 {
			localAddr = parts[0]
			remoteAddr = parts[1]
			state = "ESTABLISHED"
		} else {
			localAddr = nameField
			state = "LISTEN"
		}

		conns = append(conns, NetworkConnectionInfo{
			Protocol:    proto,
			LocalAddr:   localAddr,
			RemoteAddr:  remoteAddr,
			State:       state,
			PID:         uint32(pid),
			ProcessName: procName,
		})
		count++
	}

	return conns
}

// GetAllDrivesDarwin returns info about all mounted filesystems.
func GetAllDrivesDarwin() []DriveInfo {
	var drives []DriveInfo

	cmd := exec.Command("df", "-h")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	header := true
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if header {
			header = false
			continue
		}
		if line == "" {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}

		mount := fields[4]
		totalStr := fields[1]
		usedStr := fields[2]

		// Parse usage percentage
		usage, _ := strconv.ParseFloat(strings.TrimSuffix(fields[4], "%"), 64)

		drives = append(drives, DriveInfo{
			Mount: mount,
			Usage: usage,
			Used:  usedStr,
			Total: totalStr,
			FS:    "unknown",
		})
	}

	return drives
}

// GetInterestingEnvVarsDarwin returns environment variables.
func GetInterestingEnvVarsDarwin() map[string]string {
	interesting := []string{
		"USER", "HOME", "SHELL", "PATH", "LANG", "TERM",
		"HOSTNAME", "PWD", "DISPLAY", "TMPDIR",
		"SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY",
	}

	result := make(map[string]string)
	for _, key := range interesting {
		val := os.Getenv(key)
		if val != "" {
			result[key] = val
		}
	}
	return result
}

// GetLoggedInUsersDarwin returns currently logged in users.
func GetLoggedInUsersDarwin() []string {
	cmd := exec.Command("who")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	var users []string
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 1 {
			users = append(users, fields[0])
		}
	}
	return users
}

// GetCronJobsDarwin returns cron jobs.
func GetCronJobsDarwin() []CronJobInfo {
	var jobs []CronJobInfo

	// Check /etc/crontab
	f, err := os.Open("/etc/crontab")
	if err == nil {
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 7 {
				continue
			}
			schedule := strings.Join(fields[:5], " ")
			user := fields[5]
			command := strings.Join(fields[6:], " ")
			jobs = append(jobs, CronJobInfo{
				User:     user,
				Command:  command,
				Schedule: schedule,
				File:     "/etc/crontab",
			})
		}
		f.Close()
	}

	// Check /etc/cron.d/
	entries, err := os.ReadDir("/etc/cron.d")
	if err == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			f, err := os.Open("/etc/cron.d/" + entry.Name())
			if err != nil {
				continue
			}
			scanner := bufio.NewScanner(f)
			for scanner.Scan() {
				line := strings.TrimSpace(scanner.Text())
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				fields := strings.Fields(line)
				if len(fields) < 7 {
					continue
				}
				schedule := strings.Join(fields[:5], " ")
				user := fields[5]
				command := strings.Join(fields[6:], " ")
				jobs = append(jobs, CronJobInfo{
					User:     user,
					Command:  command,
					Schedule: schedule,
					File:     "/etc/cron.d/" + entry.Name(),
				})
			}
			f.Close()
		}
	}

	// Check user crontab
	cmd := exec.Command("crontab", "-l")
	out, err := cmd.Output()
	if err == nil {
		scanner := bufio.NewScanner(strings.NewReader(string(out)))
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 6 {
				continue
			}
			schedule := strings.Join(fields[:5], " ")
			command := strings.Join(fields[5:], " ")
			user, _ := user.Current()
			jobs = append(jobs, CronJobInfo{
				User:     user.Username,
				Command:  command,
				Schedule: schedule,
				File:     "user crontab",
			})
		}
	}

	return jobs
}

// GetLaunchAgents returns user launch agents.
func GetLaunchAgents() []LaunchItemInfo {
	var items []LaunchItemInfo

	locations := []string{
		"/Library/LaunchAgents",
	}

	// Add user-specific location
	home, err := os.UserHomeDir()
	if err == nil {
		locations = append(locations, home+"/Library/LaunchAgents")
	}

	for _, loc := range locations {
		entries, err := os.ReadDir(loc)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !strings.HasSuffix(entry.Name(), ".plist") {
				continue
			}
			path := loc + "/" + entry.Name()
			info := parseLaunchdPlist(path, loc)
			if info.Label != "" {
				items = append(items, info)
			}
		}
	}

	return items
}

// GetLaunchDaemons returns system launch daemons.
func GetLaunchDaemons() []LaunchItemInfo {
	var items []LaunchItemInfo

	loc := "/Library/LaunchDaemons"
	entries, err := os.ReadDir(loc)
	if err != nil {
		return items
	}

	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".plist") {
			continue
		}
		path := loc + "/" + entry.Name()
		info := parseLaunchdPlist(path, loc)
		if info.Label != "" {
			items = append(items, info)
		}
	}

	return items
}

func parseLaunchdPlist(path string, location string) LaunchItemInfo {
	// Use plutil to convert to JSON, then parse
	cmd := exec.Command("plutil", "-convert", "json", "-o", "-", path)
	_, err := cmd.Output()
	if err != nil {
		// Fallback: use defaults command
		cmd = exec.Command("defaults", "read", strings.TrimSuffix(path, ".plist"))
		_, err = cmd.Output()
		if err != nil {
			return LaunchItemInfo{}
		}
	}

	// Simple regex extraction from plist content
	content, err := os.ReadFile(path)
	if err != nil {
		return LaunchItemInfo{}
	}

	text := string(content)
	info := LaunchItemInfo{Location: location}

	// Extract Label
	labelRe := regexp.MustCompile(`<key>Label</key>\s*<string>([^<]+)</string>`)
	if m := labelRe.FindStringSubmatch(text); len(m) > 1 {
		info.Label = m[1]
	}

	// Extract Program/ProgramArguments
	progRe := regexp.MustCompile(`<key>Program</key>\s*<string>([^<]+)</string>`)
	if m := progRe.FindStringSubmatch(text); len(m) > 1 {
		info.Program = m[1]
	} else {
		// Try ProgramArguments first string
		progArgsRe := regexp.MustCompile(`<key>ProgramArguments</key>\s*<array>\s*<string>([^<]+)</string>`)
		if m := progArgsRe.FindStringSubmatch(text); len(m) > 1 {
			info.Program = m[1]
		}
	}

	// Extract RunAtLoad
	if strings.Contains(text, "<key>RunAtLoad</key>") && strings.Contains(text, "<true/>") {
		info.RunAtLoad = true
	}

	// Extract KeepAlive
	if strings.Contains(text, "<key>KeepAlive</key>") && strings.Contains(text, "<true/>") {
		info.KeepAlive = true
	}

	// Extract Disabled
	if strings.Contains(text, "<key>Disabled</key>") && strings.Contains(text, "<true/>") {
		info.Disabled = true
	}

	return info
}

// GetWiFiProfilesDarwin returns saved WiFi networks with passwords.
func GetWiFiProfilesDarwin() []WiFiProfileInfo {
	// Get list of preferred WiFi networks
	cmd := exec.Command("networksetup", "-listpreferredwirelessnetworks", "en0")
	cmd.SysProcAttr = &syscall.SysProcAttr{}
	out, err := cmd.Output()
	if err != nil {
		// Try en1
		cmd = exec.Command("networksetup", "-listpreferredwirelessnetworks", "en1")
		out, err = cmd.Output()
		if err != nil {
			return nil
		}
	}

	lines := strings.Split(string(out), "\n")
	if len(lines) < 2 {
		return nil
	}

	var results []WiFiProfileInfo
	for i := 1; i < len(lines); i++ {
		ssid := strings.TrimSpace(lines[i])
		if ssid == "" || ssid == "(No preferred networks found)" {
			continue
		}
		// Remove leading whitespace and any trailing info
		ssid = strings.TrimLeft(ssid, " \t-")

		// Try to get password from keychain
		cmd2 := exec.Command("security", "find-generic-password", "-wa", ssid)
		cmd2.SysProcAttr = &syscall.SysProcAttr{}
		out2, err2 := cmd2.Output()
		password := ""
		if err2 == nil {
			password = strings.TrimSpace(string(out2))
		}

		results = append(results, WiFiProfileInfo{
			SSID:     ssid,
			Password: password,
			Security: "WPA/WPA2",
		})
	}

	if len(results) > 0 {
		return results
	}
	return nil
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
