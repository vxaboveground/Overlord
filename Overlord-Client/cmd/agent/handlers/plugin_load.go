package handlers

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"

	"overlord-client/cmd/agent/plugins"
	agentRuntime "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

const maxPluginBinaryBytes = 200 * 1024 * 1024

func HandlePluginLoadHTTP(ctx context.Context, env *agentRuntime.Env, cmdID string, manifest plugins.PluginManifest, pullURL string, expectedSize int64) error {
	if env.Plugins == nil {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: "plugin manager not ready"})
	}

	resolved, err := resolvePluginPullURL(env, pullURL)
	if err != nil {
		_ = wire.WriteMsg(ctx, env.Conn, wire.PluginEvent{Type: "plugin_event", PluginID: manifest.ID, Event: "error", Error: err.Error()})
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
	}

	tlsConfig := &tls.Config{InsecureSkipVerify: env.Cfg.TLSInsecureSkipVerify, MinVersion: tls.VersionTLS12}
	if caPath := strings.TrimSpace(env.Cfg.TLSCAPath); caPath != "" {
		caBytes, err := os.ReadFile(caPath)
		if err != nil {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: fmt.Sprintf("failed to read TLS CA: %v", err)})
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caBytes) {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: "failed to parse TLS CA"})
		}
		tlsConfig.RootCAs = pool
	}

	client := &http.Client{Transport: &http.Transport{TLSClientConfig: tlsConfig}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, resolved, nil)
	if err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
	}
	if token := strings.TrimSpace(env.Cfg.AgentToken); token != "" {
		req.Header.Set("x-agent-token", token)
	}
	if id := strings.TrimSpace(env.Cfg.ID); id != "" {
		req.Header.Set("x-overlord-client-id", id)
	}

	resp, err := client.Do(req)
	if err != nil {
		_ = wire.WriteMsg(ctx, env.Conn, wire.PluginEvent{Type: "plugin_event", PluginID: manifest.ID, Event: "error", Error: err.Error()})
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := fmt.Sprintf("plugin pull failed: status %d", resp.StatusCode)
		_ = wire.WriteMsg(ctx, env.Conn, wire.PluginEvent{Type: "plugin_event", PluginID: manifest.ID, Event: "error", Error: msg})
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: msg})
	}

	limit := int64(maxPluginBinaryBytes)
	if expectedSize > 0 && expectedSize < limit {
		limit = expectedSize
	}
	binary, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		_ = wire.WriteMsg(ctx, env.Conn, wire.PluginEvent{Type: "plugin_event", PluginID: manifest.ID, Event: "error", Error: err.Error()})
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
	}
	if int64(len(binary)) > limit {
		msg := "plugin pull exceeded size limit"
		_ = wire.WriteMsg(ctx, env.Conn, wire.PluginEvent{Type: "plugin_event", PluginID: manifest.ID, Event: "error", Error: msg})
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: msg})
	}
	if expectedSize > 0 && int64(len(binary)) != expectedSize {
		msg := "plugin pull size mismatch"
		_ = wire.WriteMsg(ctx, env.Conn, wire.PluginEvent{Type: "plugin_event", PluginID: manifest.ID, Event: "error", Error: msg})
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: msg})
	}

	if err := env.Plugins.Load(ctx, manifest, binary); err != nil {
		log.Printf("[plugin] load failed %s: %v", manifest.ID, err)
		_ = wire.WriteMsg(ctx, env.Conn, wire.PluginEvent{Type: "plugin_event", PluginID: manifest.ID, Event: "error", Error: err.Error()})
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
	}
	_ = wire.WriteMsg(ctx, env.Conn, wire.PluginEvent{Type: "plugin_event", PluginID: manifest.ID, Event: "loaded"})
	return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true})
}

func resolvePluginPullURL(env *agentRuntime.Env, raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New("missing plugin pull url")
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("invalid plugin pull url: %w", err)
	}

	if parsed.IsAbs() {
		scheme := strings.ToLower(parsed.Scheme)
		if scheme != "http" && scheme != "https" {
			return "", fmt.Errorf("unsupported plugin pull scheme: %s", parsed.Scheme)
		}
		return parsed.String(), nil
	}

	if len(env.Cfg.ServerURLs) == 0 {
		return "", errors.New("no server url configured for plugin pull")
	}
	idx := env.Cfg.ServerIndex
	if idx < 0 || idx >= len(env.Cfg.ServerURLs) {
		idx = 0
	}
	server, err := url.Parse(env.Cfg.ServerURLs[idx])
	if err != nil {
		return "", fmt.Errorf("invalid agent server url: %w", err)
	}
	switch strings.ToLower(server.Scheme) {
	case "wss":
		server.Scheme = "https"
	case "ws":
		server.Scheme = "http"
	case "https", "http":
	default:
		return "", fmt.Errorf("unsupported agent server scheme: %s", server.Scheme)
	}
	server.Path = parsed.Path
	server.RawQuery = parsed.RawQuery
	server.Fragment = ""
	return server.String(), nil
}
