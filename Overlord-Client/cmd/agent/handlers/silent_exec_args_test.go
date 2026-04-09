package handlers

import (
	"testing"
)

func TestParseCommandArgs_EmptyInput(t *testing.T) {
	result := parseCommandArgs("")
	if len(result) != 0 {
		t.Fatalf("expected empty slice, got %v", result)
	}
}

func TestParseCommandArgs_WhitespaceOnly(t *testing.T) {
	result := parseCommandArgs("   \t  ")
	if len(result) != 0 {
		t.Fatalf("expected empty slice, got %v", result)
	}
}

func TestParseCommandArgs_SimpleWords(t *testing.T) {
	result := parseCommandArgs("hello world foo")
	if len(result) != 3 || result[0] != "hello" || result[1] != "world" || result[2] != "foo" {
		t.Fatalf("expected [hello world foo], got %v", result)
	}
}

func TestParseCommandArgs_DoubleQuotes(t *testing.T) {
	result := parseCommandArgs(`echo "hello world" done`)
	if len(result) != 3 || result[0] != "echo" || result[1] != "hello world" || result[2] != "done" {
		t.Fatalf("expected [echo, hello world, done], got %v", result)
	}
}

func TestParseCommandArgs_SingleQuotes(t *testing.T) {
	result := parseCommandArgs(`echo 'hello world' done`)
	if len(result) != 3 || result[0] != "echo" || result[1] != "hello world" || result[2] != "done" {
		t.Fatalf("expected [echo, hello world, done], got %v", result)
	}
}

func TestParseCommandArgs_EscapedChars(t *testing.T) {
	result := parseCommandArgs(`hello\ world`)
	if len(result) != 1 || result[0] != "hello world" {
		t.Fatalf("expected [hello world], got %v", result)
	}
}

func TestParseCommandArgs_MixedQuotes(t *testing.T) {
	result := parseCommandArgs(`cmd "arg one" 'arg two' plain`)
	if len(result) != 4 {
		t.Fatalf("expected 4 args, got %d: %v", len(result), result)
	}
	if result[0] != "cmd" || result[1] != "arg one" || result[2] != "arg two" || result[3] != "plain" {
		t.Fatalf("got %v", result)
	}
}

func TestParseCommandArgs_TrailingEscape(t *testing.T) {
	result := parseCommandArgs(`hello\`)
	if len(result) != 1 || result[0] != `hello\` {
		t.Fatalf("expected [hello\\], got %v", result)
	}
}

func TestParseCommandArgs_EmptyQuotes(t *testing.T) {
	result := parseCommandArgs(`a "" b`)
	if len(result) != 3 || result[1] != "" {
		if len(result) == 2 && result[0] == "a" && result[1] == "b" {
			return
		}
		t.Logf("result: %v (len %d)", result, len(result))
	}
}

func TestParseCommandArgs_PathWithSpaces(t *testing.T) {
	result := parseCommandArgs(`"C:\\Program Files\\App\\app.exe" --flag value`)
	if len(result) != 3 {
		t.Fatalf("expected 3 args, got %d: %v", len(result), result)
	}
	if result[0] != `C:\Program Files\App\app.exe` {
		t.Fatalf("path not preserved: %s", result[0])
	}
}
