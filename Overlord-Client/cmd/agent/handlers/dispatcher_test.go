package handlers

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"overlord-client/cmd/agent/config"
	rt "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"

	"github.com/vmihailenco/msgpack/v5"
	"nhooyr.io/websocket"
)

const disconnectHelperEnv = "GO_WANT_DISCONNECT_HELPER_PROCESS"
const disconnectMsgFileEnv = "GO_DISCONNECT_MSG_FILE"

type disconnectExitFileWriter struct {
	path string
}

func (w *disconnectExitFileWriter) Write(ctx context.Context, messageType websocket.MessageType, p []byte) error {
	return os.WriteFile(w.path, append([]byte(nil), p...), 0600)
}

func TestHandlePing(t *testing.T) {
	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}
	env.SetLastPong(0)

	ctx := context.Background()
	envelope := map[string]interface{}{
		"ts": float64(1234567890),
	}

	if err := HandlePing(ctx, env, envelope); err != nil {
		t.Fatalf("HandlePing failed: %v", err)
	}

	deadline := time.After(2 * time.Second)
	for len(writer.msgs) < 1 {
		select {
		case <-deadline:
			t.Fatal("Timed out waiting for pong message")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}

	var pong wire.Pong
	if err := msgpack.Unmarshal(writer.msgs[0], &pong); err != nil {
		t.Fatalf("Failed to unmarshal pong: %v", err)
	}

	if pong.Type != "pong" {
		t.Errorf("Expected type 'pong', got '%s'", pong.Type)
	}
	expectedTS := int64(1234567890)
	if pong.TS != expectedTS {
		t.Errorf("Expected timestamp %d, got %d", expectedTS, pong.TS)
	}

	if env.LastPong().IsZero() {
		t.Fatalf("expected LastPong to be updated on ping")
	}
	if time.Since(env.LastPong()) > 5*time.Second {
		t.Fatalf("expected LastPong to be recent, got %s", env.LastPong())
	}
}

func TestHandlePingPreservesZeroTimestamp(t *testing.T) {
	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()
	envelope := map[string]interface{}{
		"ts": int64(0),
	}

	if err := HandlePing(ctx, env, envelope); err != nil {
		t.Fatalf("HandlePing failed: %v", err)
	}

	deadline := time.After(2 * time.Second)
	for len(writer.msgs) < 1 {
		select {
		case <-deadline:
			t.Fatal("Timed out waiting for pong message")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}

	var pong wire.Pong
	if err := msgpack.Unmarshal(writer.msgs[0], &pong); err != nil {
		t.Fatalf("Failed to unmarshal pong: %v", err)
	}
	if pong.TS != 0 {
		t.Fatalf("expected timestamp 0, got %d", pong.TS)
	}
}

func TestHandlePingFallsBackForInvalidTimestamp(t *testing.T) {
	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()
	before := time.Now().UnixMilli()
	envelope := map[string]interface{}{
		"ts": "not-a-timestamp",
	}

	if err := HandlePing(ctx, env, envelope); err != nil {
		t.Fatalf("HandlePing failed: %v", err)
	}

	deadline := time.After(2 * time.Second)
	for len(writer.msgs) < 1 {
		select {
		case <-deadline:
			t.Fatal("Timed out waiting for pong message")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}

	var pong wire.Pong
	if err := msgpack.Unmarshal(writer.msgs[0], &pong); err != nil {
		t.Fatalf("Failed to unmarshal pong: %v", err)
	}
	after := time.Now().UnixMilli()
	if pong.TS < before || pong.TS > after {
		t.Fatalf("expected fallback timestamp between %d and %d, got %d", before, after, pong.TS)
	}
}

func TestHandleCommand_Ping(t *testing.T) {
	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()

	envelope := map[string]interface{}{
		"type":        "command",
		"commandType": "ping",
		"id":          "cmd-ping-1",
		"ts":          float64(1234567890),
	}

	if err := HandleCommand(ctx, env, envelope); err != nil {
		t.Fatalf("HandleCommand(ping) failed: %v", err)
	}

	if len(writer.msgs) < 1 {
		t.Fatal("Expected at least 1 message")
	}

	var firstMsg map[string]interface{}
	if err := msgpack.Unmarshal(writer.msgs[0], &firstMsg); err != nil {
		t.Fatalf("Failed to unmarshal first message: %v", err)
	}

	msgType, _ := firstMsg["type"].(string)
	t.Logf("First message type: %s", msgType)
}

func TestHandleCommand_Desktop(t *testing.T) {
	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()

	envelope := map[string]interface{}{
		"type":        "command",
		"commandType": "desktop",
		"id":          "cmd-desktop-1",
		"payload":     map[string]interface{}{},
	}

	if err := HandleCommand(ctx, env, envelope); err != nil {
		t.Fatalf("HandleCommand(desktop) failed: %v", err)
	}

	t.Logf("Desktop command sent %d messages", len(writer.msgs))
}

func TestHandleCommand_ProcessList(t *testing.T) {
	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()

	envelope := map[string]interface{}{
		"type":        "command",
		"commandType": "process_list",
		"id":          "cmd-proc-1",
		"payload":     map[string]interface{}{},
	}

	if err := HandleCommand(ctx, env, envelope); err != nil {
		t.Fatalf("HandleCommand(process_list) failed: %v", err)
	}

	if len(writer.msgs) != 1 {
		t.Fatalf("Expected 1 message, got %d", len(writer.msgs))
	}

	var result wire.ProcessListResult
	if err := msgpack.Unmarshal(writer.msgs[0], &result); err != nil {
		t.Fatalf("Failed to unmarshal result: %v", err)
	}

	if result.Type != "process_list_result" {
		t.Errorf("Expected process_list_result")
	}
}

func TestHandleCommand_FileList(t *testing.T) {
	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()
	tmpDir := t.TempDir()

	envelope := map[string]interface{}{
		"type":        "command",
		"commandType": "file_list",
		"id":          "cmd-file-1",
		"payload":     map[string]interface{}{"path": tmpDir},
	}

	if err := HandleCommand(ctx, env, envelope); err != nil {
		t.Fatalf("HandleCommand(file_list) failed: %v", err)
	}

	if len(writer.msgs) != 1 {
		t.Fatalf("Expected 1 message, got %d", len(writer.msgs))
	}

	var result wire.FileListResult
	if err := msgpack.Unmarshal(writer.msgs[0], &result); err != nil {
		t.Fatalf("Failed to unmarshal result: %v", err)
	}

	if result.Type != "file_list_result" {
		t.Errorf("Expected file_list_result")
	}
}

func TestHandleCommand_UnknownCommand(t *testing.T) {
	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()

	envelope := map[string]interface{}{
		"type":        "command",
		"commandType": "unknown_command_xyz",
		"id":          "cmd-unknown-1",
		"payload":     map[string]interface{}{},
	}

	if err := HandleCommand(ctx, env, envelope); err != nil {
		t.Logf("Unknown command returned error (expected): %v", err)
	}

	t.Logf("Unknown command handling sent %d messages", len(writer.msgs))
}

func TestHandleCommand_DisconnectTriggersReconnect(t *testing.T) {
	if os.Getenv(disconnectHelperEnv) == "1" {
		msgPath := os.Getenv(disconnectMsgFileEnv)
		if msgPath == "" {
			t.Fatal("missing disconnect message file path")
		}

		env := &rt.Env{
			Conn: &disconnectExitFileWriter{path: msgPath},
			Cfg:  config.Config{},
		}

		ctx := context.Background()
		envelope := map[string]interface{}{
			"type":        "command",
			"commandType": "disconnect",
			"id":          "cmd-disconnect-1",
		}

		err := HandleCommand(ctx, env, envelope)
		t.Fatalf("expected process exit for disconnect, got return err=%v", err)
	}

	msgPath := filepath.Join(t.TempDir(), "disconnect-msg.bin")
	cmd := exec.Command(os.Args[0], "-test.run=^TestHandleCommand_DisconnectTriggersReconnect$")
	cmd.Env = append(os.Environ(), disconnectHelperEnv+"=1", disconnectMsgFileEnv+"="+msgPath)

	if err := cmd.Run(); err != nil {
		t.Fatalf("expected disconnect helper to exit cleanly, got %v", err)
	}

	raw, err := os.ReadFile(msgPath)
	if err != nil {
		t.Fatalf("failed to read disconnect message file: %v", err)
	}
	if len(raw) == 0 {
		t.Fatal("expected command_result response")
	}

	var result wire.CommandResult
	if err := msgpack.Unmarshal(raw, &result); err != nil {
		t.Fatalf("failed to unmarshal command_result: %v", err)
	}
	if !result.OK {
		t.Fatalf("expected ok=true, got false")
	}
}

func TestHandleCommand_ReconnectTriggersReconnect(t *testing.T) {
	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()
	envelope := map[string]interface{}{
		"type":        "command",
		"commandType": "reconnect",
		"id":          "cmd-reconnect-1",
	}

	err := HandleCommand(ctx, env, envelope)
	if !errors.Is(err, ErrReconnect) {
		t.Fatalf("expected ErrReconnect, got %v", err)
	}
	if len(writer.msgs) < 1 {
		t.Fatal("expected command_result response")
	}

	var result wire.CommandResult
	if err := msgpack.Unmarshal(writer.msgs[0], &result); err != nil {
		t.Fatalf("failed to unmarshal command_result: %v", err)
	}
	if !result.OK {
		t.Fatalf("expected ok=true, got false")
	}
}

func TestCommandPayloadExtraction(t *testing.T) {

	tests := []struct {
		name     string
		payload  interface{}
		key      string
		expected interface{}
	}{
		{
			name:     "StringValue",
			payload:  map[string]interface{}{"path": "/test/path"},
			key:      "path",
			expected: "/test/path",
		},
		{
			name:     "IntValue",
			payload:  map[string]interface{}{"pid": float64(1234)},
			key:      "pid",
			expected: float64(1234),
		},
		{
			name:     "BoolValue",
			payload:  map[string]interface{}{"recursive": true},
			key:      "recursive",
			expected: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			payloadMap, ok := tt.payload.(map[string]interface{})
			if !ok {
				t.Fatal("Payload is not a map")
			}

			value, exists := payloadMap[tt.key]
			if !exists {
				t.Errorf("Key %s not found in payload", tt.key)
			}

			if value != tt.expected {
				t.Errorf("Expected %v, got %v", tt.expected, value)
			}
		})
	}
}
