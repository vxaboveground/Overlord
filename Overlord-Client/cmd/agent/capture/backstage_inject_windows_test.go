//go:build windows

package capture

import (
	"slices"
	"syscall"
	"testing"
)

func TestAppendEnvironmentOverridesPreservesUnicodeAndReplacesRDI(t *testing.T) {
	raw := testEnvironmentBlock(t,
		"=C:=C:\\Users\\tester",
		"Path=C:\\Windows\\System32",
		"RDI_SEARCH_PATH=C:\\stale",
		"rdi_dll_size=not-a-number",
		"USERNAME=Jose\u0301",
	)

	block, err := appendEnvironmentOverrides(raw, []string{
		"RDI_SEARCH_PATH=C:\\Users\\\u6d4b\u8bd5\\Profile",
		"RDI_REPLACE_PATH=D:\\Clone\\\u590d\u5236",
		"RDI_DLL_SECTION=Local\\OverlordRDI_123",
		"RDI_DLL_SIZE=12345",
	})
	if err != nil {
		t.Fatalf("appendEnvironmentOverrides: %v", err)
	}
	if len(block) < 2 || block[len(block)-1] != 0 || block[len(block)-2] != 0 {
		t.Fatalf("environment block is not double-NUL terminated: tail=%v", block[max(0, len(block)-4):])
	}

	entries, err := environmentBlockEntries(block)
	if err != nil {
		t.Fatalf("environmentBlockEntries: %v", err)
	}

	for _, stale := range []string{"RDI_SEARCH_PATH=C:\\stale", "rdi_dll_size=not-a-number"} {
		if slices.Contains(entries, stale) {
			t.Fatalf("stale RDI entry was preserved: %q in %#v", stale, entries)
		}
	}

	for _, want := range []string{
		"=C:=C:\\Users\\tester",
		"USERNAME=Jose\u0301",
		"RDI_SEARCH_PATH=C:\\Users\\\u6d4b\u8bd5\\Profile",
		"RDI_REPLACE_PATH=D:\\Clone\\\u590d\u5236",
		"RDI_DLL_SIZE=12345",
	} {
		if !slices.Contains(entries, want) {
			t.Fatalf("missing environment entry %q in %#v", want, entries)
		}
	}
}

func testEnvironmentBlock(t *testing.T, entries ...string) []uint16 {
	t.Helper()

	var block []uint16
	for _, entry := range entries {
		u, err := syscall.UTF16FromString(entry)
		if err != nil {
			t.Fatalf("UTF16FromString(%q): %v", entry, err)
		}
		block = append(block, u...)
	}
	return append(block, 0)
}
