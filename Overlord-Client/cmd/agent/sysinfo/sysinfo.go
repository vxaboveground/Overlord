package sysinfo

type Info struct {
	CPU             string `json:"cpu,omitempty"`
	GPU             string `json:"gpu,omitempty"`
	RAM             string `json:"ram,omitempty"`
	BatteryPercent  *int   `json:"batteryPercent,omitempty"`
	BatteryCharging bool   `json:"batteryCharging,omitempty"`
}

func Collect() Info {
	//garble:controlflow block_splits=10 junk_jumps=10 flatten_passes=2
	return collectPlatform()
}
