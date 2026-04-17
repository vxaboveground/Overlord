//go:build linux

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
		idle, total := readStatCPU()
		cpuLastIdle = idle
		cpuLastTotal = total
		cpuLastTime = time.Now()
	})

	cpuMu.Lock()
	defer cpuMu.Unlock()

	idle, total := readStatCPU()
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

func readStatCPU() (idle, total uint64) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 1
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			return 0, 1
		}
		// cpu user nice system idle iowait irq softirq
		user, _ := strconv.ParseUint(fields[1], 10, 64)
		nice, _ := strconv.ParseUint(fields[2], 10, 64)
		system, _ := strconv.ParseUint(fields[3], 10, 64)
		idleVal, _ := strconv.ParseUint(fields[4], 10, 64)
		iowait, _ := strconv.ParseUint(fields[5], 10, 64)
		irq, _ := strconv.ParseUint(fields[6], 10, 64)
		softirq, _ := strconv.ParseUint(fields[7], 10, 64)

		idle = idleVal + iowait
		total = user + nice + system + idle + iowait + irq + softirq
		break
	}
	return
}

// GetRAMUsage returns RAM usage percentage and used/total in bytes.
func GetRAMUsage() (usagePercent float64, usedBytes, totalBytes uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, 0
	}
	defer f.Close()

	var memTotal, memAvailable uint64
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			memTotal, _ = strconv.ParseUint(fields[1], 10, 64)
			memTotal *= 1024 // kB to bytes
		}
		if strings.HasPrefix(line, "MemAvailable:") {
			fields := strings.Fields(line)
			memAvailable, _ = strconv.ParseUint(fields[1], 10, 64)
			memAvailable *= 1024
		}
	}

	if memTotal == 0 {
		return 0, 0, 0
	}

	usedBytes = memTotal - memAvailable
	usagePercent = float64(usedBytes) / float64(memTotal) * 100.0
	totalBytes = memTotal
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

	uptime := getUptime()
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
		OSInfo:             getOSInfo(),
		Arch:               getArch(),
		KernelVersion:      getKernelVersion(),
		NetworkConnections: GetNetworkConnections(),
		AllDrives:          GetAllDrives(),
		EnvVars:            GetInterestingEnvVars(),
		LoggedInUsers:      GetLoggedInUsers(),
		CronJobs:           GetCronJobs(),
		SystemdUnits:       GetSystemdUnits(),
		InstalledPkgs:      GetInstalledPackages(),
		WiFiProfiles:       GetWiFiProfiles(),

		LocalIP:        GetLocalIP(),
		DefaultGateway: GetDefaultGateway(),
		DNSServers:     GetDNSServers(),
		MappedDrives:   GetMappedDrives(),
		PSHistory:      GetPSHistory(),
	}
}

// GetLocalIP returns the primary non-loopback local IP via `ip route`.
func GetLocalIP() string {
	out, err := exec.Command("ip", "route", "get", "1.1.1.1").Output()
	if err == nil {
		// format: "1.1.1.1 via x.x.x.x dev eth0 src 192.168.1.5 ..."
		parts := strings.Fields(string(out))
		for i, p := range parts {
			if p == "src" && i+1 < len(parts) {
				return strings.TrimSpace(parts[i+1])
			}
		}
	}
	// Fallback: hostname -I
	out2, err2 := exec.Command("hostname", "-I").Output()
	if err2 == nil {
		fields := strings.Fields(string(out2))
		if len(fields) > 0 {
			return fields[0]
		}
	}
	return ""
}

// GetDefaultGateway returns the default gateway via `ip route`.
func GetDefaultGateway() string {
	out, err := exec.Command("ip", "route", "show", "default").Output()
	if err != nil {
		return ""
	}
	// format: "default via x.x.x.x dev eth0 ..."
	parts := strings.Fields(string(out))
	for i, p := range parts {
		if p == "via" && i+1 < len(parts) {
			return strings.TrimSpace(parts[i+1])
		}
	}
	return ""
}

// GetDNSServers returns DNS servers from /etc/resolv.conf.
func GetDNSServers() []string {
	data, err := os.ReadFile("/etc/resolv.conf")
	if err != nil {
		return nil
	}
	var servers []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "nameserver ") {
			ip := strings.TrimSpace(strings.TrimPrefix(line, "nameserver "))
			if ip != "" {
				servers = append(servers, ip)
			}
		}
	}
	return servers
}

// GetMappedDrives returns mounted CIFS/SMB shares (Linux).
func GetMappedDrives() []MappedDriveInfo {
	data, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return nil
	}
	var drives []MappedDriveInfo
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		fsType := fields[2]
		if fsType == "cifs" || fsType == "smbfs" || fsType == "nfs" || fsType == "nfs4" {
			drives = append(drives, MappedDriveInfo{
				Letter: fields[1], // mountpoint
				Path:   fields[0], // //server/share
				Status: "Mounted",
			})
		}
	}
	return drives
}

// GetPSHistory reads bash/zsh history for the current user.
func GetPSHistory() string {
	home := os.Getenv("HOME")
	if home == "" {
		return ""
	}
	// Try bash, zsh, fish in order
	candidates := []string{
		home + "/.bash_history",
		home + "/.zsh_history",
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

func getUptime() time.Duration {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(data))
	if len(fields) < 1 {
		return 0
	}
	seconds, _ := strconv.ParseFloat(fields[0], 64)
	return time.Duration(seconds * float64(time.Second))
}

func getOSInfo() string {
	// Try reading /etc/os-release
	f, err := os.Open("/etc/os-release")
	if err != nil {
		// Fallback to uname
		out, _ := exec.Command("uname", "-o").Output()
		return strings.TrimSpace(string(out))
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			val := strings.TrimPrefix(line, "PRETTY_NAME=")
			val = strings.Trim(val, "\"")
			return val
		}
	}
	return "Linux"
}

func getArch() string {
	out, _ := exec.Command("uname", "-m").Output()
	return strings.TrimSpace(string(out))
}

func getKernelVersion() string {
	out, _ := exec.Command("uname", "-r").Output()
	return strings.TrimSpace(string(out))
}

// GetNetworkConnections returns active network connections.
func GetNetworkConnections() []NetworkConnectionInfo {
	cmd := exec.Command("ss", "-tunap")
	cmd.SysProcAttr = &syscall.SysProcAttr{}
	out, err := cmd.Output()
	if err != nil {
		// Fallback to netstat
		cmd = exec.Command("netstat", "-tunap")
		out, err = cmd.Output()
		if err != nil {
			return nil
		}
	}

	var conns []NetworkConnectionInfo
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
		if len(fields) < 6 {
			continue
		}

		proto := fields[0]
		if strings.HasPrefix(proto, "tcp") {
			proto = "TCP"
		} else if strings.HasPrefix(proto, "udp") {
			proto = "UDP"
		}

		localAddr := fields[4]
		remoteAddr := fields[5]
		state := ""
		if proto == "TCP" && len(fields) > 2 {
			state = fields[1]
			localAddr = fields[4]
			remoteAddr = fields[5]
		}

		// Extract PID/Process from last field like "users:(("bash",pid=1234,fd=3))"
		pid := uint32(0)
		procName := ""
		if len(fields) >= 7 {
			lastField := strings.Join(fields[6:], " ")
			pidRe := regexp.MustCompile(`pid=(\d+)`)
			nameRe := regexp.MustCompile(`"\(([^"]+)"`)
			if m := pidRe.FindStringSubmatch(lastField); len(m) > 1 {
				p, _ := strconv.ParseUint(m[1], 10, 32)
				pid = uint32(p)
			}
			if m := nameRe.FindStringSubmatch(lastField); len(m) > 1 {
				procName = m[1]
			}
		}

		conns = append(conns, NetworkConnectionInfo{
			Protocol:    proto,
			LocalAddr:   localAddr,
			RemoteAddr:  remoteAddr,
			State:       state,
			PID:         pid,
			ProcessName: procName,
		})
	}

	return conns
}

// GetAllDrives returns info about all mounted filesystems.
func GetAllDrives() []DriveInfo {
	var drives []DriveInfo

	cmd := exec.Command("df", "-T", "-P")
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
		if len(fields) < 7 {
			continue
		}

		mount := fields[6]
		fsType := fields[1]
		totalStr := fields[2] // in 1K blocks
		usedStr := fields[3]

		totalKB, _ := strconv.ParseUint(totalStr, 10, 64)
		usedKB, _ := strconv.ParseUint(usedStr, 10, 64)

		totalBytes := totalKB * 1024
		usedBytes := usedKB * 1024

		var usage float64
		if totalBytes > 0 {
			usage = float64(usedBytes) / float64(totalBytes) * 100.0
		}

		drives = append(drives, DriveInfo{
			Mount: mount,
			Type:  fsType,
			Usage: usage,
			Used:  FormatBytes(usedBytes),
			Total: FormatBytes(totalBytes),
			FS:    fsType,
		})
	}

	return drives
}

// GetInterestingEnvVars returns environment variables.
func GetInterestingEnvVars() map[string]string {
	interesting := []string{
		"USER", "HOME", "SHELL", "PATH", "LANG", "TERM",
		"HOSTNAME", "PWD", "DISPLAY", "XDG_SESSION_TYPE",
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

// GetLoggedInUsers returns currently logged in users.
func GetLoggedInUsers() []string {
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

// GetCronJobs returns cron jobs for all users.
func GetCronJobs() []CronJobInfo {
	var jobs []CronJobInfo

	// Check system crontab locations
	cronDirs := []string{
		"/etc/cron.d",
		"/etc/crontab",
	}

	for _, dir := range cronDirs {
		if dir == "/etc/crontab" {
			// Parse /etc/crontab
			f, err := os.Open(dir)
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
				// Format: min hour dom month dow user command...
				schedule := strings.Join(fields[:5], " ")
				user := fields[5]
				command := strings.Join(fields[6:], " ")
				jobs = append(jobs, CronJobInfo{
					User:     user,
					Command:  command,
					Schedule: schedule,
					File:     dir,
				})
			}
			f.Close()
		} else {
			// /etc/cron.d/ - each file is a crontab
			entries, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, entry := range entries {
				if entry.IsDir() {
					continue
				}
				f, err := os.Open(dir + "/" + entry.Name())
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
						File:     dir + "/" + entry.Name(),
					})
				}
				f.Close()
			}
		}
	}

	// Check user crontabs
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

// GetSystemdUnits returns active systemd units.
func GetSystemdUnits() []UnitInfo {
	cmd := exec.Command("systemctl", "list-units", "--type=service", "--no-pager", "--no-legend")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	var units []UnitInfo
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}

		units = append(units, UnitInfo{
			Name:        fields[0],
			Description: fields[1],
			LoadState:   fields[2],
			ActiveState: fields[3],
			SubState:    fields[4],
		})
	}

	return units
}

// GetInstalledPackages returns installed package names.
func GetInstalledPackages() []string {
	var pkgs []string

	// Try dpkg (Debian/Ubuntu)
	cmd := exec.Command("dpkg", "-l")
	out, err := cmd.Output()
	if err == nil {
		scanner := bufio.NewScanner(strings.NewReader(string(out)))
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "ii") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				pkgs = append(pkgs, fields[1])
			}
		}
		return pkgs
	}

	// Try rpm (RHEL/CentOS/Fedora)
	cmd = exec.Command("rpm", "-qa")
	out, err = cmd.Output()
	if err == nil {
		scanner := bufio.NewScanner(strings.NewReader(string(out)))
		for scanner.Scan() {
			pkgs = append(pkgs, strings.TrimSpace(scanner.Text()))
		}
		return pkgs
	}

	// Try pacman (Arch)
	cmd = exec.Command("pacman", "-Q")
	out, err = cmd.Output()
	if err == nil {
		scanner := bufio.NewScanner(strings.NewReader(string(out)))
		for scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			if len(fields) >= 1 {
				pkgs = append(pkgs, fields[0])
			}
		}
		return pkgs
	}

	return nil
}

// GetWiFiProfiles returns saved WiFi networks with passwords.
func GetWiFiProfiles() []WiFiProfileInfo {
	// Try NetworkManager (most modern Linux distros)
	cmd := exec.Command("nmcli", "-t", "-f", "NAME", "connection", "show")
	cmd.SysProcAttr = &syscall.SysProcAttr{}
	out, err := cmd.Output()
	if err == nil {
		var results []WiFiProfileInfo
		scanner := bufio.NewScanner(strings.NewReader(string(out)))
		for scanner.Scan() {
			ssid := strings.TrimSpace(scanner.Text())
			if ssid == "" {
				continue
			}
			// Check if it's a WiFi connection
			cmd2 := exec.Command("nmcli", "-t", "-f", "802-11-wireless.ssid,type", "connection", "show", ssid)
			cmd2.SysProcAttr = &syscall.SysProcAttr{}
			out2, err2 := cmd2.Output()
			if err2 != nil {
				continue
			}
			lines := strings.Split(string(out2), "\n")
			isWifi := false
			for _, l := range lines {
				if strings.Contains(l, "802-11-wireless") {
					isWifi = true
				}
			}
			if !isWifi {
				continue
			}
			// Get password
			cmd3 := exec.Command("nmcli", "-t", "-s", "-f", "802-11-wireless-security.psk", "connection", "show", ssid)
			cmd3.SysProcAttr = &syscall.SysProcAttr{}
			out3, err3 := cmd3.Output()
			password := ""
			if err3 == nil {
				password = strings.TrimSpace(string(out3))
				// Remove field prefix if present
				if idx := strings.Index(password, ":"); idx >= 0 {
					password = strings.TrimSpace(password[idx+1:])
				}
			}
			// Get security type
			cmd4 := exec.Command("nmcli", "-t", "-f", "802-11-wireless-security.key-mgmt", "connection", "show", ssid)
			cmd4.SysProcAttr = &syscall.SysProcAttr{}
			out4, err4 := cmd4.Output()
			security := ""
			if err4 == nil {
				security = strings.TrimSpace(string(out4))
				if idx := strings.Index(security, ":"); idx >= 0 {
					security = strings.TrimSpace(security[idx+1:])
				}
			}
			results = append(results, WiFiProfileInfo{
				SSID:     ssid,
				Password: password,
				Security: security,
			})
		}
		if len(results) > 0 {
			return results
		}
	}

	// Fallback: parse wpa_supplicant config files
	cmd = exec.Command("cat", "/etc/wpa_supplicant/wpa_supplicant.conf")
	cmd.SysProcAttr = &syscall.SysProcAttr{}
	out, err = cmd.Output()
	if err != nil {
		return nil
	}

	var results []WiFiProfileInfo
	var currentSSID, currentPsk, currentKeyMgmt string
	inNetwork := false

	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "network={" {
			inNetwork = true
			currentSSID = ""
			currentPsk = ""
			currentKeyMgmt = ""
			continue
		}
		if line == "}" && inNetwork {
			if currentSSID != "" {
				results = append(results, WiFiProfileInfo{
					SSID:     strings.Trim(currentSSID, "\""),
					Password: strings.Trim(currentPsk, "\""),
					Security: currentKeyMgmt,
				})
			}
			inNetwork = false
			continue
		}
		if !inNetwork {
			continue
		}
		if strings.HasPrefix(line, "ssid=") {
			currentSSID = strings.TrimPrefix(line, "ssid=")
		}
		if strings.HasPrefix(line, "psk=") {
			currentPsk = strings.TrimPrefix(line, "psk=")
		}
		if strings.HasPrefix(line, "key_mgmt=") {
			currentKeyMgmt = strings.TrimPrefix(line, "key_mgmt=")
		}
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
