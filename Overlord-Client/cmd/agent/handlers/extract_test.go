package handlers

import (
	"encoding/json"
	"math"
	"testing"
)

func TestExtractTimestamp_Int64(t *testing.T) {
	var ts int64 = 1700000000000
	if got := extractTimestamp(ts); got != ts {
		t.Fatalf("expected %d, got %d", ts, got)
	}
}

func TestExtractTimestamp_Uint64(t *testing.T) {
	var ts uint64 = 1700000000000
	if got := extractTimestamp(ts); got != int64(ts) {
		t.Fatalf("expected %d, got %d", ts, got)
	}
}

func TestExtractTimestamp_Uint64Overflow(t *testing.T) {
	// Values exceeding max int64 should return 0
	var ts uint64 = math.MaxUint64
	if got := extractTimestamp(ts); got != 0 {
		t.Fatalf("expected 0 for overflow, got %d", got)
	}
}

func TestExtractTimestamp_Uint32(t *testing.T) {
	var ts uint32 = 170000
	if got := extractTimestamp(ts); got != int64(ts) {
		t.Fatalf("expected %d, got %d", ts, got)
	}
}

func TestExtractTimestamp_Uint16(t *testing.T) {
	var ts uint16 = 1234
	if got := extractTimestamp(ts); got != int64(ts) {
		t.Fatalf("expected %d, got %d", ts, got)
	}
}

func TestExtractTimestamp_Uint8(t *testing.T) {
	var ts uint8 = 42
	if got := extractTimestamp(ts); got != int64(ts) {
		t.Fatalf("expected %d, got %d", ts, got)
	}
}

func TestExtractTimestamp_Int32(t *testing.T) {
	var ts int32 = 12345678
	if got := extractTimestamp(ts); got != int64(ts) {
		t.Fatalf("expected %d, got %d", ts, got)
	}
}

func TestExtractTimestamp_Int16(t *testing.T) {
	var ts int16 = 9999
	if got := extractTimestamp(ts); got != int64(ts) {
		t.Fatalf("expected %d, got %d", ts, got)
	}
}

func TestExtractTimestamp_Int8(t *testing.T) {
	var ts int8 = 127
	if got := extractTimestamp(ts); got != int64(ts) {
		t.Fatalf("expected %d, got %d", ts, got)
	}
}

func TestExtractTimestamp_Int(t *testing.T) {
	var ts int = 1700000000
	if got := extractTimestamp(ts); got != int64(ts) {
		t.Fatalf("expected %d, got %d", ts, got)
	}
}

func TestExtractTimestamp_Float64(t *testing.T) {
	var ts float64 = 1700000000000.0
	if got := extractTimestamp(ts); got != int64(ts) {
		t.Fatalf("expected %d, got %d", int64(ts), got)
	}
}

func TestExtractTimestamp_Float32(t *testing.T) {
	var ts float32 = 170000.0
	if got := extractTimestamp(ts); got != int64(ts) {
		t.Fatalf("expected %d, got %d", int64(ts), got)
	}
}

func TestExtractTimestamp_JsonNumber(t *testing.T) {
	n := json.Number("1700000000000")
	if got := extractTimestamp(n); got != 1700000000000 {
		t.Fatalf("expected 1700000000000, got %d", got)
	}
}

func TestExtractTimestamp_InvalidJsonNumber(t *testing.T) {
	n := json.Number("not-a-number")
	if got := extractTimestamp(n); got != 0 {
		t.Fatalf("expected 0 for invalid json.Number, got %d", got)
	}
}

func TestExtractTimestamp_String(t *testing.T) {
	if got := extractTimestamp("hello"); got != 0 {
		t.Fatalf("expected 0 for string, got %d", got)
	}
}

func TestExtractTimestamp_Nil(t *testing.T) {
	if got := extractTimestamp(nil); got != 0 {
		t.Fatalf("expected 0 for nil, got %d", got)
	}
}

func TestExtractTimestamp_Bool(t *testing.T) {
	if got := extractTimestamp(true); got != 0 {
		t.Fatalf("expected 0 for bool, got %d", got)
	}
}

func TestExtractTimestamp_Zero(t *testing.T) {
	if got := extractTimestamp(int64(0)); got != 0 {
		t.Fatalf("expected 0, got %d", got)
	}
}

func TestExtractTimestamp_Negative(t *testing.T) {
	var ts int64 = -100
	if got := extractTimestamp(ts); got != ts {
		t.Fatalf("expected %d, got %d", ts, got)
	}
}
