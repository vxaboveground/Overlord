package handlers

import (
	"os"
	"testing"
	"time"
)

func TestStreamInterval_Default(t *testing.T) {
	os.Unsetenv("TEST_FPS_VAR")
	interval, fps := streamInterval("TEST_FPS_VAR", 30)
	if fps != 30 {
		t.Fatalf("expected fps=30, got %d", fps)
	}
	expected := time.Second / 30
	if interval != expected {
		t.Fatalf("expected interval=%v, got %v", expected, interval)
	}
}

func TestStreamInterval_CustomValue(t *testing.T) {
	os.Setenv("TEST_FPS_VAR2", "60")
	defer os.Unsetenv("TEST_FPS_VAR2")

	interval, fps := streamInterval("TEST_FPS_VAR2", 30)
	if fps != 60 {
		t.Fatalf("expected fps=60, got %d", fps)
	}
	expected := time.Second / 60
	if interval != expected {
		t.Fatalf("expected interval=%v, got %v", expected, interval)
	}
}

func TestStreamInterval_InvalidFallsBack(t *testing.T) {
	os.Setenv("TEST_FPS_BAD", "abc")
	defer os.Unsetenv("TEST_FPS_BAD")

	_, fps := streamInterval("TEST_FPS_BAD", 25)
	if fps != 25 {
		t.Fatalf("expected default fps=25 on bad input, got %d", fps)
	}
}

func TestStreamInterval_ZeroFallsBack(t *testing.T) {
	os.Setenv("TEST_FPS_ZERO", "0")
	defer os.Unsetenv("TEST_FPS_ZERO")

	_, fps := streamInterval("TEST_FPS_ZERO", 15)
	if fps != 15 {
		t.Fatalf("expected fps=15 when env=0, got %d", fps)
	}
}

func TestStreamInterval_NegativeFallsBack(t *testing.T) {
	os.Setenv("TEST_FPS_NEG", "-5")
	defer os.Unsetenv("TEST_FPS_NEG")

	_, fps := streamInterval("TEST_FPS_NEG", 20)
	if fps != 20 {
		t.Fatalf("expected fps=20 on negative input, got %d", fps)
	}
}

func TestStreamInterval_ClampMax(t *testing.T) {
	os.Setenv("TEST_FPS_HIGH", "9999")
	defer os.Unsetenv("TEST_FPS_HIGH")

	_, fps := streamInterval("TEST_FPS_HIGH", 30)
	if fps != 1000 {
		t.Fatalf("expected clamped fps=1000, got %d", fps)
	}
}

func TestStreamInterval_ClampMin(t *testing.T) {
	os.Unsetenv("TEST_FPS_MIN")
	_, fps := streamInterval("TEST_FPS_MIN", 0)
	if fps != 1 {
		t.Fatalf("expected clamped fps=1, got %d", fps)
	}
}

func TestStreamInterval_WhitespaceEnv(t *testing.T) {
	os.Setenv("TEST_FPS_WS", "  45  ")
	defer os.Unsetenv("TEST_FPS_WS")

	_, fps := streamInterval("TEST_FPS_WS", 30)
	if fps != 45 {
		t.Fatalf("expected fps=45 (trimmed whitespace), got %d", fps)
	}
}
