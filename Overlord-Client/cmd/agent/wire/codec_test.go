package wire

import (
	"testing"

	"github.com/vmihailenco/msgpack/v5"
)

func TestDecodeEnvelope_ValidMessage(t *testing.T) {
	original := map[string]interface{}{
		"type":        "hello",
		"id":          "test-id",
		"commandType": "console",
	}

	data, err := msgpack.Marshal(original)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	decoded, err := DecodeEnvelope(data)
	if err != nil {
		t.Fatalf("failed to decode: %v", err)
	}

	if decoded["type"] != "hello" {
		t.Fatalf("expected type=hello, got %v", decoded["type"])
	}
	if decoded["id"] != "test-id" {
		t.Fatalf("expected id=test-id, got %v", decoded["id"])
	}
}

func TestDecodeEnvelope_EmptyMap(t *testing.T) {
	data, _ := msgpack.Marshal(map[string]interface{}{})
	decoded, err := DecodeEnvelope(data)
	if err != nil {
		t.Fatalf("failed to decode empty map: %v", err)
	}
	if len(decoded) != 0 {
		t.Fatalf("expected empty map, got %v", decoded)
	}
}

func TestDecodeEnvelope_InvalidData(t *testing.T) {
	_, err := DecodeEnvelope([]byte{0xFF, 0xFE, 0xFD})
	if err == nil {
		t.Fatal("expected error for invalid msgpack data")
	}
}

func TestDecodeEnvelope_NestedPayload(t *testing.T) {
	original := map[string]interface{}{
		"type": "command",
		"payload": map[string]interface{}{
			"path":    "/tmp/test",
			"recurse": true,
		},
	}

	data, _ := msgpack.Marshal(original)
	decoded, err := DecodeEnvelope(data)
	if err != nil {
		t.Fatalf("failed to decode: %v", err)
	}

	payload, ok := decoded["payload"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected payload to be a map, got %T", decoded["payload"])
	}
	if payload["path"] != "/tmp/test" {
		t.Fatalf("expected path=/tmp/test, got %v", payload["path"])
	}
}

func TestDecodeEnvelope_NumericValues(t *testing.T) {
	original := map[string]interface{}{
		"type":  "ping",
		"ts":    int64(1700000000000),
		"count": uint32(42),
	}

	data, _ := msgpack.Marshal(original)
	decoded, err := DecodeEnvelope(data)
	if err != nil {
		t.Fatalf("failed to decode: %v", err)
	}

	if decoded["type"] != "ping" {
		t.Fatalf("expected type=ping, got %v", decoded["type"])
	}
}

func TestDecodeEnvelope_NilBytes(t *testing.T) {
	_, err := DecodeEnvelope(nil)
	if err == nil {
		t.Fatal("expected error for nil input")
	}
}

func TestDecodeEnvelope_EmptyBytes(t *testing.T) {
	_, err := DecodeEnvelope([]byte{})
	if err == nil {
		t.Fatal("expected error for empty input")
	}
}
