package plugins

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildFileACL(t *testing.T) {
	acl := buildFileACL(PluginNeeds{Files: []PluginFileNeed{
		{Bucket: "downloads", Access: []string{"read", "list"}},
	}})
	if !acl["downloads"]["read"] || !acl["downloads"]["list"] {
		t.Fatalf("expected read/list permissions: %#v", acl)
	}
	if acl["downloads"]["write"] {
		t.Fatalf("did not expect write permission")
	}
}

func TestWriteWASMOutputStatusCodes(t *testing.T) {
	status := statusTooSmall
	if wasmStatus(statusTooSmall) != uint64(uint32(status)) {
		t.Fatalf("negative status should be encoded as wasm i32")
	}
}

func TestResolvePluginBucketPathRejectsTraversal(t *testing.T) {
	target, status := resolvePluginBucketPath("demo", "pluginData", ".."+string(filepath.Separator)+"escape.txt")
	if status != statusOK {
		t.Fatalf("expected cleaned pluginData path, got status %d", status)
	}
	if strings.Contains(target, "..") {
		t.Fatalf("expected traversal to be cleaned, got %q", target)
	}

	_, status = resolvePluginBucketPath("demo", "downloads", string(filepath.Separator)+"absolute.txt")
	if status != statusDenied {
		t.Fatalf("expected absolute path to be denied for scoped bucket, got %d", status)
	}
}
