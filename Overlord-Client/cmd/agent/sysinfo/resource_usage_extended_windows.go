//go:build windows

package sysinfo

import (
	"bufio"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// GetScheduledTasks returns all non-Microsoft scheduled tasks.
func GetScheduledTasks() []ScheduledTaskInfo {
	cmd := exec.Command("schtasks", "/query", "/fo", "csv", "/v")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	var tasks []ScheduledTaskInfo
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	header := true
	for scanner.Scan() {
		line := scanner.Text()
		if header {
			header = false
			continue
		}
		if strings.TrimSpace(line) == "" {
			continue
		}

		// Parse CSV (simple, no quoted commas expected in task fields)
		fields := parseCSVLine(line)
		if len(fields) < 9 {
			continue
		}

		taskName := strings.TrimSpace(fields[0])
		// Skip Microsoft tasks
		if strings.Contains(strings.ToLower(taskName), `\microsoft\`) {
			continue
		}

		status := strings.TrimSpace(fields[1])
		nextRun := strings.TrimSpace(fields[2])
		author := strings.TrimSpace(fields[7])
		taskToRun := strings.TrimSpace(fields[8])

		tasks = append(tasks, ScheduledTaskInfo{
			Name:    taskName,
			Path:    taskName,
			State:   status,
			NextRun: nextRun,
			Author:  author,
			Command: taskToRun,
		})
	}

	return tasks
}

// GetRegistryPersistence scans common registry persistence locations.
func GetRegistryPersistence() []RegistryPersistenceInfo {
	var results []RegistryPersistenceInfo

	// Keys to scan for persistence
	runKeys := []struct {
		key  registry.Key
		path string
	}{
		{registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`},
		{registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\RunOnce`},
		{registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\RunOnceEx`},
		{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`},
		{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce`},
		{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnceEx`},
		{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run`},
		{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\RunOnce`},
	}

	// Also check HKCU\Environment for persistence via UserInitMprLogonScript
	envKeys := []struct {
		key  registry.Key
		path string
	}{
		{registry.CURRENT_USER, `Environment`},
	}

	allKeys := append(runKeys, envKeys...)

	for _, rk := range allKeys {
		k, err := registry.OpenKey(rk.key, rk.path, registry.READ)
		if err != nil {
			continue
		}

		names, err := k.ReadValueNames(0)
		if err != nil {
			k.Close()
			continue
		}

		for _, name := range names {
			val, valTypeNum, err := k.GetStringValue(name)
			if err != nil {
				// Try reading as DWORD
				dw, _, err2 := k.GetIntegerValue(name)
				if err2 == nil {
					val = fmt.Sprintf("%d", dw)
					valTypeNum = registry.DWORD
				} else {
					// Skip values we can't read as strings or integers
					continue
				}
			}

			keyPath := keyPathToString(rk.key) + `\` + rk.path
			results = append(results, RegistryPersistenceInfo{
				Key:   keyPath,
				Name:  name,
				Value: val,
				Type:  registryTypeToString(valTypeNum),
			})
		}
		k.Close()
	}

	// Check UserInitMprLogonScript specifically
	k, err := registry.OpenKey(registry.CURRENT_USER, `Environment`, registry.READ)
	if err == nil {
		val, _, err := k.GetStringValue("UserInitMprLogonScript")
		if err == nil && val != "" {
			results = append(results, RegistryPersistenceInfo{
				Key:   `HKCU\Environment`,
				Name:  "UserInitMprLogonScript",
				Value: val,
				Type:  "PERSISTENCE",
			})
		}
		k.Close()
	}

	// Check Winlogon keys for Shell/Userinit
	winlogonPaths := []string{
		`SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`,
	}
	for _, wp := range winlogonPaths {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, wp, registry.READ)
		if err != nil {
			continue
		}
		checkVals := []string{"Shell", "Userinit", "VMApplet", "Taskman"}
		for _, cv := range checkVals {
			val, valTypeNum, err := k.GetStringValue(cv)
			if err == nil && val != "" {
				results = append(results, RegistryPersistenceInfo{
					Key:   `HKLM\` + wp,
					Name:  cv,
					Value: val,
					Type:  registryTypeToString(valTypeNum),
				})
			}
		}
		k.Close()
	}

	return results
}

// GetNetworkConnections returns active network connections.
func GetNetworkConnections() []NetworkConnectionInfo {
	cmd := exec.Command("netstat", "-ano")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	var conns []NetworkConnectionInfo
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	header := true
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if header {
			header = true // skip header
			continue
		}
		if line == "" || !strings.HasPrefix(line, "TCP") && !strings.HasPrefix(line, "UDP") {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}

		proto := fields[0]
		localAddr := fields[1]
		remoteAddr := fields[2]
		pidStr := fields[3]

		var pid uint32
		fmt.Sscanf(pidStr, "%d", &pid)

		state := ""
		if proto == "TCP" && len(fields) >= 5 {
			state = fields[3]
			pidStr = fields[4]
			fmt.Sscanf(pidStr, "%d", &pid)
		}

		procName := getProcessNameByPID(pid)

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

// GetRunningServices returns all running Windows services.
func GetRunningServices() []ServiceInfo {
	cmd := exec.Command("powershell", "-NoProfile", "-Command",
		`Get-CimInstance -ClassName Win32_Service -Property Name,DisplayName,State,StartMode,PathName | Where-Object {$_.State -eq 'Running'} | Select-Object Name,DisplayName,State,StartMode,PathName | ConvertTo-Json -Compress`)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	// Parse JSON array manually (simple approach)
	var services []ServiceInfo
	// Use regex to extract fields
	nameRe := regexp.MustCompile(`"Name":"([^"]*)"`)
	displayRe := regexp.MustCompile(`"DisplayName":"([^"]*)"`)
	stateRe := regexp.MustCompile(`"State":"([^"]*)"`)
	modeRe := regexp.MustCompile(`"StartMode":"([^"]*)"`)
	pathRe := regexp.MustCompile(`"PathName":"([^"]*)"`)

	names := nameRe.FindAllStringSubmatch(string(out), -1)
	displays := displayRe.FindAllStringSubmatch(string(out), -1)
	states := stateRe.FindAllStringSubmatch(string(out), -1)
	modes := modeRe.FindAllStringSubmatch(string(out), -1)
	paths := pathRe.FindAllStringSubmatch(string(out), -1)

	count := len(names)
	if count == 0 {
		return nil
	}

	for i := 0; i < count; i++ {
		s := ServiceInfo{}
		if i < len(names) {
			s.Name = names[i][1]
		}
		if i < len(displays) {
			s.DisplayName = displays[i][1]
		}
		if i < len(states) {
			s.State = states[i][1]
		}
		if i < len(modes) {
			s.StartMode = modes[i][1]
		}
		if i < len(paths) {
			s.PathName = paths[i][1]
		}
		services = append(services, s)
	}

	return services
}

// GetStartupPrograms returns programs configured to start at login.
func GetStartupPrograms() []StartupProgramInfo {
	var programs []StartupProgramInfo

	// Check registry startup locations
	startupKeys := []struct {
		key      registry.Key
		path     string
		location string
	}{
		{registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Run`, "HKCU Run"},
		{registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\RunOnce`, "HKCU RunOnce"},
		{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`, "HKLM Run"},
		{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce`, "HKLM RunOnce"},
		{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run`, "HKLM WOW64 Run"},
	}

	for _, sk := range startupKeys {
		k, err := registry.OpenKey(sk.key, sk.path, registry.READ)
		if err != nil {
			continue
		}

		names, err := k.ReadValueNames(0)
		if err != nil {
			k.Close()
			continue
		}

		for _, name := range names {
			val, _, err := k.GetStringValue(name)
			if err != nil {
				continue
			}
			programs = append(programs, StartupProgramInfo{
				Name:     name,
				Path:     val,
				Location: sk.location,
			})
		}
		k.Close()
	}

	// Check startup folders
	startupFolders := []string{
		`C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup`,
	}

	// Get user-specific startup folder via environment
	cmd := exec.Command("cmd", "/c", "echo %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	userStartup, err := cmd.Output()
	if err == nil {
		startupFolders = append(startupFolders, strings.TrimSpace(string(userStartup)))
	}

	for _, folder := range startupFolders {
		entries, err := exec.Command("dir", "/b", folder).Output()
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(strings.NewReader(string(entries)))
		for scanner.Scan() {
			name := strings.TrimSpace(scanner.Text())
			if name == "" {
				continue
			}
			programs = append(programs, StartupProgramInfo{
				Name:     name,
				Path:     folder + `\` + name,
				Location: "Startup Folder",
			})
		}
	}

	return programs
}

// GetAllDrives returns info about all drives on the system.
func GetAllDrives() []DriveInfo {
	var drives []DriveInfo

	// Get logical drives
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	getLogicalDrives := kernel32.NewProc("GetLogicalDrives")
	getDriveType := kernel32.NewProc("GetDriveTypeW")
	getVolumeInfo := kernel32.NewProc("GetVolumeInformationW")
	getDiskFreeSpaceEx := kernel32.NewProc("GetDiskFreeSpaceExW")

	driveMask, _, _ := getLogicalDrives.Call()

	for i := 0; i < 26; i++ {
		if driveMask&(1<<i) == 0 {
			continue
		}

		letter := string(rune('A'+i)) + ":"
		letterPtr := windows.StringToUTF16Ptr(letter + `\`)

		// Get drive type
		dt, _, _ := getDriveType.Call(uintptr(unsafe.Pointer(letterPtr)))
		driveType := "Unknown"
		switch dt {
		case 2:
			driveType = "Removable"
		case 3:
			driveType = "Fixed"
		case 4:
			driveType = "Remote"
		case 5:
			driveType = "CD-ROM"
		case 6:
			driveType = "RAM Disk"
		}

		// Get volume label
		var volName [261]uint16
		var fsName [16]uint16
		getVolumeInfo.Call(
			uintptr(unsafe.Pointer(letterPtr)),
			uintptr(unsafe.Pointer(&volName[0])),
			260,
			0, 0, 0,
			uintptr(unsafe.Pointer(&fsName[0])),
			15,
		)
		label := windows.UTF16ToString(volName[:])
		fs := windows.UTF16ToString(fsName[:])

		// Get disk space
		var freeBytes, totalBytes, totalFree uint64
		ret, _, _ := getDiskFreeSpaceEx.Call(
			uintptr(unsafe.Pointer(letterPtr)),
			uintptr(unsafe.Pointer(&freeBytes)),
			uintptr(unsafe.Pointer(&totalBytes)),
			uintptr(unsafe.Pointer(&totalFree)),
		)

		var usage float64
		var usedStr, totalStr string
		if ret != 0 && totalBytes > 0 {
			usedBytes := totalBytes - freeBytes
			usage = float64(usedBytes) / float64(totalBytes) * 100.0
			usedStr = FormatBytes(usedBytes)
			totalStr = FormatBytes(totalBytes)
		} else {
			usedStr = "N/A"
			totalStr = "N/A"
		}

		drives = append(drives, DriveInfo{
			Mount: letter,
			Label: label,
			Type:  driveType,
			Usage: usage,
			Used:  usedStr,
			Total: totalStr,
			FS:    fs,
		})
	}

	return drives
}

// GetInterestingEnvVars returns environment variables that might be relevant.
func GetInterestingEnvVars() map[string]string {
	interesting := []string{
		"USERNAME", "USERDOMAIN", "USERPROFILE", "HOMEPATH", "HOMEDRIVE",
		"COMPUTERNAME", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
		"TEMP", "TMP", "SYSTEMROOT", "WINDIR", "PROGRAMDATA",
		"PUBLIC", "ALLUSERSPROFILE", "APPDATA", "LOCALAPPDATA",
		"PATH", "PATHEXT", "COMSPEC", "PSModulePath",
	}

	result := make(map[string]string)
	for _, key := range interesting {
		val := getEnvVar(key)
		if val != "" {
			result[key] = val
		}
	}

	return result
}

// GetLoggedInUsers returns currently logged in users.
func GetLoggedInUsers() []string {
	cmd := exec.Command("query", "user")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		// Fallback: use whoami
		cmd2 := exec.Command("whoami")
		cmd2.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		out2, err2 := cmd2.Output()
		if err2 != nil {
			return nil
		}
		return []string{strings.TrimSpace(string(out2))}
	}

	var users []string
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
		// Format: USERNAME SESSIONNAME ID STATE IDLE TIME LOGON TIME
		fields := strings.Fields(line)
		if len(fields) >= 1 {
			users = append(users, fields[0])
		}
	}

	return users
}

// GetAntivirusProducts returns detected antivirus products via WMI.
func GetAntivirusProducts() []string {
	cmd := exec.Command("powershell", "-NoProfile", "-Command",
		`try { Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | Select-Object -ExpandProperty displayName } catch { '' }`)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	var products []string
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			products = append(products, line)
		}
	}

	return products
}

// GetWiFiProfiles returns saved WiFi networks with passwords.
func GetWiFiProfiles() []WiFiProfileInfo {
	// Get list of profiles
	cmd := exec.Command("netsh", "wlan", "show", "profiles")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	// Parse profile names
	var profiles []string
	re := regexp.MustCompile(`All User Profile\s+:\s+(.+)`)
	for _, line := range strings.Split(string(out), "\n") {
		matches := re.FindStringSubmatch(line)
		if len(matches) >= 2 {
			profiles = append(profiles, strings.TrimSpace(matches[1]))
		}
	}

	if len(profiles) == 0 {
		return nil
	}

	var results []WiFiProfileInfo
	for _, ssid := range profiles {
		// Get password for each profile
		cmd := exec.Command("netsh", "wlan", "show", "profile", "name="+ssid, "key=clear")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		out, err := cmd.Output()
		if err != nil {
			continue
		}

		var password, security string
		for _, line := range strings.Split(string(out), "\n") {
			if strings.Contains(line, "Key Content") {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					password = strings.TrimSpace(parts[1])
				}
			}
			if strings.Contains(line, "Authentication") {
				parts := strings.SplitN(line, ":", 2)
				if len(parts) == 2 {
					security = strings.TrimSpace(parts[1])
				}
			}
		}

		results = append(results, WiFiProfileInfo{
			SSID:     ssid,
			Password: password,
			Security: security,
		})
	}

	return results
}

// Helper functions

func parseCSVLine(line string) []string {
	var fields []string
	var current strings.Builder
	inQuotes := false

	for _, ch := range line {
		switch ch {
		case '"':
			inQuotes = !inQuotes
		case ',':
			if !inQuotes {
				fields = append(fields, current.String())
				current.Reset()
			} else {
				current.WriteRune(ch)
			}
		default:
			current.WriteRune(ch)
		}
	}
	fields = append(fields, current.String())
	return fields
}

func getProcessNameByPID(pid uint32) string {
	if pid == 0 {
		return ""
	}
	cmd := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/NH")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 1 {
			return fields[0]
		}
	}
	return ""
}

func getEnvVar(name string) string {
	cmd := exec.Command("cmd", "/c", "echo %"+name+"%")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func registryTypeToString(t uint32) string {
	switch t {
	case registry.SZ:
		return "SZ"
	case registry.EXPAND_SZ:
		return "EXPAND_SZ"
	case registry.BINARY:
		return "BINARY"
	case registry.DWORD:
		return "DWORD"
	case registry.MULTI_SZ:
		return "MULTI_SZ"
	case registry.QWORD:
		return "QWORD"
	default:
		return fmt.Sprintf("UNKNOWN(%d)", t)
	}
}

func keyPathToString(key registry.Key) string {
	switch key {
	case registry.CURRENT_USER:
		return "HKCU"
	case registry.LOCAL_MACHINE:
		return "HKLM"
	case registry.CLASSES_ROOT:
		return "HKCR"
	case registry.USERS:
		return "HKU"
	case registry.CURRENT_CONFIG:
		return "HKCC"
	default:
		return "UNKNOWN"
	}
}
