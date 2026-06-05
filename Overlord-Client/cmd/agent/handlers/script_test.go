package handlers

import (
	"context"
	goruntime "runtime"
	"sync"
	"testing"
	"time"

	"overlord-client/cmd/agent/config"
	rt "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"

	"github.com/vmihailenco/msgpack/v5"
	"nhooyr.io/websocket"
)

type scriptTestWriter struct {
	mu   sync.Mutex
	msgs [][]byte
}

func (w *scriptTestWriter) Write(ctx context.Context, messageType websocket.MessageType, p []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.msgs = append(w.msgs, append([]byte(nil), p...))
	return nil
}

func (w *scriptTestWriter) popScriptResult() (wire.ScriptResult, bool, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, msg := range w.msgs {
		var result wire.ScriptResult
		if err := msgpack.Unmarshal(msg, &result); err != nil {
			return wire.ScriptResult{}, false, err
		}
		if result.Type == "script_result" {
			return result, true, nil
		}
	}
	return wire.ScriptResult{}, false, nil
}

func TestHandleCommandScriptExecRunsAsync(t *testing.T) {
	writer := &scriptTestWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	scriptType := "sh"
	script := "sleep 0.2; echo done"
	if goruntime.GOOS == "windows" {
		scriptType = "cmd"
		script = "ping 127.0.0.1 -n 2 >NUL & echo done"
	}

	envelope := map[string]interface{}{
		"type":        "command",
		"commandType": "script_exec",
		"id":          "cmd-script-async",
		"payload": map[string]interface{}{
			"script": script,
			"type":   scriptType,
		},
	}

	start := time.Now()
	if err := HandleCommand(context.Background(), env, envelope); err != nil {
		t.Fatalf("HandleCommand(script_exec) failed: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("script_exec blocked dispatcher for %s", elapsed)
	}

	deadline := time.After(5 * time.Second)
	for {
		result, ok, err := writer.popScriptResult()
		if err != nil {
			t.Fatalf("failed to decode script result: %v", err)
		}
		if ok {
			if !result.OK {
				t.Fatalf("expected script ok=true, got error=%q output=%q", result.Error, result.Output)
			}
			if result.Output != "done" {
				t.Fatalf("expected output %q, got %q", "done", result.Output)
			}
			return
		}

		select {
		case <-deadline:
			t.Fatal("timed out waiting for script result")
		default:
			time.Sleep(10 * time.Millisecond)
		}
	}
}
