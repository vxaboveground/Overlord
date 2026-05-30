package handlers

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"overlord-client/cmd/agent/config"
	rt "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"

	"github.com/vmihailenco/msgpack/v5"
	"nhooyr.io/websocket"
)

type testWriter struct {
	msgs [][]byte
}

func (w *testWriter) Write(ctx context.Context, messageType websocket.MessageType, p []byte) error {
	w.msgs = append(w.msgs, append([]byte(nil), p...))
	return nil
}

func TestHandleFileList(t *testing.T) {

	tmpDir := t.TempDir()

	testFile1 := filepath.Join(tmpDir, "test1.txt")
	testFile2 := filepath.Join(tmpDir, "test2.txt")
	testDir := filepath.Join(tmpDir, "testdir")

	if err := os.WriteFile(testFile1, []byte("content1"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	if err := os.WriteFile(testFile2, []byte("content2"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}
	if err := os.Mkdir(testDir, 0755); err != nil {
		t.Fatalf("Failed to create test directory: %v", err)
	}

	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()
	cmdID := "test-cmd-1"

	if err := HandleFileList(ctx, env, cmdID, tmpDir); err != nil {
		t.Fatalf("HandleFileList failed: %v", err)
	}

	if len(writer.msgs) != 1 {
		t.Fatalf("Expected 1 message, got %d", len(writer.msgs))
	}

	var result wire.FileListResult
	if err := msgpack.Unmarshal(writer.msgs[0], &result); err != nil {
		t.Fatalf("Failed to unmarshal result: %v", err)
	}

	if result.Type != "file_list_result" {
		t.Errorf("Expected type 'file_list_result', got '%s'", result.Type)
	}
	if result.CommandID != cmdID {
		t.Errorf("Expected CommandID '%s', got '%s'", cmdID, result.CommandID)
	}
	if len(result.Entries) != 3 {
		t.Errorf("Expected 3 entries, got %d", len(result.Entries))
	}

	names := make(map[string]bool)
	for _, entry := range result.Entries {
		names[entry.Name] = entry.IsDir
	}

	if len(names) != 3 {
		t.Logf("Found entries: %v", names)
	}

	hasTest1 := false
	hasTest2 := false
	hasTestDir := false
	for name, isDir := range names {
		if name == "test1.txt" {
			hasTest1 = true
		}
		if name == "test2.txt" {
			hasTest2 = true
		}
		if isDir {
			hasTestDir = true
		}
	}

	if !hasTest1 || !hasTest2 || !hasTestDir {
		t.Errorf("Missing expected entries - test1:%v test2:%v testdir:%v", hasTest1, hasTest2, hasTestDir)
	}
}

func TestHandleFileList_InvalidPath(t *testing.T) {
	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()
	cmdID := "test-cmd-2"

	invalidPath := filepath.Join(t.TempDir(), "nonexistent")
	if err := HandleFileList(ctx, env, cmdID, invalidPath); err != nil {
		t.Fatalf("HandleFileList should not return error: %v", err)
	}

	if len(writer.msgs) != 1 {
		t.Fatalf("Expected 1 message, got %d", len(writer.msgs))
	}

	var result wire.FileListResult
	if err := msgpack.Unmarshal(writer.msgs[0], &result); err != nil {
		t.Fatalf("Failed to unmarshal result: %v", err)
	}

	if result.Error == "" {
		t.Error("Expected error message for invalid path")
	}
}

func TestHandleFileDownload(t *testing.T) {

	tmpDir := t.TempDir()
	testFile := filepath.Join(tmpDir, "download_test.txt")
	testContent := []byte("This is test content for download")

	if err := os.WriteFile(testFile, testContent, 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()
	cmdID := "test-cmd-3"

	if err := HandleFileDownload(ctx, env, cmdID, testFile); err != nil {
		t.Fatalf("HandleFileDownload failed: %v", err)
	}

	if len(writer.msgs) == 0 {
		t.Fatal("Expected at least 1 message")
	}

	var download wire.FileDownload
	if err := msgpack.Unmarshal(writer.msgs[0], &download); err != nil {
		t.Fatalf("Failed to unmarshal download message: %v", err)
	}

	if download.Type != "file_download" {
		t.Errorf("Expected type 'file_download', got '%s'", download.Type)
	}
	if download.CommandID != cmdID {
		t.Errorf("Expected CommandID '%s', got '%s'", cmdID, download.CommandID)
	}
	if download.Total != int64(len(testContent)) {
		t.Errorf("Expected total size %d, got %d", len(testContent), download.Total)
	}

	var assembled []byte
	for _, msg := range writer.msgs {
		var chunk wire.FileDownload
		if err := msgpack.Unmarshal(msg, &chunk); err != nil {
			t.Fatalf("Failed to unmarshal chunk: %v", err)
		}
		assembled = append(assembled, chunk.Data...)
	}

	if string(assembled) != string(testContent) {
		t.Errorf("Downloaded content mismatch:\ngot: %s\nwant: %s", string(assembled), string(testContent))
	}
}

func TestHandleFileDelete(t *testing.T) {

	tmpDir := t.TempDir()
	testFile := filepath.Join(tmpDir, "delete_test.txt")

	if err := os.WriteFile(testFile, []byte("delete me"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()
	cmdID := "test-cmd-4"

	if err := HandleFileDelete(ctx, env, cmdID, testFile); err != nil {
		t.Fatalf("HandleFileDelete failed: %v", err)
	}

	if _, err := os.Stat(testFile); !os.IsNotExist(err) {
		t.Error("File should have been deleted")
	}

	if len(writer.msgs) != 1 {
		t.Fatalf("Expected 1 message, got %d", len(writer.msgs))
	}

	var result wire.CommandResult
	if err := msgpack.Unmarshal(writer.msgs[0], &result); err != nil {
		t.Fatalf("Failed to unmarshal result: %v", err)
	}

	if !result.OK {
		t.Errorf("Expected OK=true, got false with message: %s", result.Message)
	}
}

func TestHandleFileMkdir(t *testing.T) {
	tmpDir := t.TempDir()
	newDir := filepath.Join(tmpDir, "newdir")

	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()
	cmdID := "test-cmd-5"

	if err := HandleFileMkdir(ctx, env, cmdID, newDir); err != nil {
		t.Fatalf("HandleFileMkdir failed: %v", err)
	}

	info, err := os.Stat(newDir)
	if err != nil {
		t.Fatalf("Directory should have been created: %v", err)
	}
	if !info.IsDir() {
		t.Error("Created path should be a directory")
	}

	if len(writer.msgs) != 1 {
		t.Fatalf("Expected 1 message, got %d", len(writer.msgs))
	}

	var result wire.CommandResult
	if err := msgpack.Unmarshal(writer.msgs[0], &result); err != nil {
		t.Fatalf("Failed to unmarshal result: %v", err)
	}

	if !result.OK {
		t.Errorf("Expected OK=true, got false with message: %s", result.Message)
	}
}

func TestHandleFileUpload(t *testing.T) {
	tmpDir := t.TempDir()
	uploadPath := filepath.Join(tmpDir, "uploaded.txt")
	uploadContent := []byte("This is uploaded content")

	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()
	cmdID := "test-cmd-6"

	if err := HandleFileUpload(ctx, env, cmdID, uploadPath, uploadContent, 0, int64(len(uploadContent)), "test-transfer"); err != nil {
		t.Fatalf("HandleFileUpload failed: %v", err)
	}

	content, err := os.ReadFile(uploadPath)
	if err != nil {
		t.Fatalf("Failed to read uploaded file: %v", err)
	}

	if string(content) != string(uploadContent) {
		t.Errorf("Upload content mismatch:\ngot: %s\nwant: %s", string(content), string(uploadContent))
	}

	if len(writer.msgs) != 1 {
		t.Fatalf("Expected 1 message, got %d", len(writer.msgs))
	}

	var result wire.FileUploadResult
	if err := msgpack.Unmarshal(writer.msgs[0], &result); err != nil {
		t.Fatalf("Failed to unmarshal result: %v", err)
	}

	if !result.OK {
		t.Errorf("Expected OK=true, got false with error: %s", result.Error)
	}
}

func TestHandleFileDownload_Chunked(t *testing.T) {
	tmpDir := t.TempDir()
	filePath := filepath.Join(tmpDir, "chunked.bin")
	data := bytes.Repeat([]byte("a"), maxChunkSize*2+123)

	if err := os.WriteFile(filePath, data, 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	writer := &testWriter{}
	env := &rt.Env{Conn: writer, Cfg: config.Config{}}
	ctx := context.Background()

	if err := HandleFileDownload(ctx, env, "cmd-chunked-dl", filePath); err != nil {
		t.Fatalf("HandleFileDownload failed: %v", err)
	}

	if len(writer.msgs) < 2 {
		t.Fatalf("Expected multiple chunks, got %d", len(writer.msgs))
	}

	var assembled []byte
	var chunksTotal int
	for _, msg := range writer.msgs {
		var chunk wire.FileDownload
		if err := msgpack.Unmarshal(msg, &chunk); err != nil {
			t.Fatalf("Failed to unmarshal chunk: %v", err)
		}
		assembled = append(assembled, chunk.Data...)
		chunksTotal = chunk.ChunksTotal
		if chunk.Total != int64(len(data)) {
			t.Fatalf("Expected total %d, got %d", len(data), chunk.Total)
		}
	}

	if chunksTotal < 2 {
		t.Fatalf("Expected chunksTotal >= 2, got %d", chunksTotal)
	}
	if !bytes.Equal(assembled, data) {
		t.Fatalf("Downloaded content mismatch")
	}
}

func TestHandleFileUpload_Chunked(t *testing.T) {
	tmpDir := t.TempDir()
	uploadPath := filepath.Join(tmpDir, "uploaded.bin")
	data := bytes.Repeat([]byte("b"), maxChunkSize*2+77)

	writer := &testWriter{}
	env := &rt.Env{Conn: writer, Cfg: config.Config{}}
	ctx := context.Background()
	cmdID := "cmd-chunked-ul"
	transferID := "transfer-123"

	chunks := [][]byte{
		data[:maxChunkSize],
		data[maxChunkSize : maxChunkSize*2],
		data[maxChunkSize*2:],
	}

	offset := int64(0)
	for _, chunk := range chunks {
		if err := HandleFileUpload(ctx, env, cmdID, uploadPath, chunk, offset, int64(len(data)), transferID); err != nil {
			t.Fatalf("HandleFileUpload failed: %v", err)
		}
		offset += int64(len(chunk))
	}

	content, err := os.ReadFile(uploadPath)
	if err != nil {
		t.Fatalf("Failed to read uploaded file: %v", err)
	}
	if !bytes.Equal(content, data) {
		t.Fatalf("Uploaded content mismatch")
	}

	if len(writer.msgs) != len(chunks) {
		t.Fatalf("Expected %d messages, got %d", len(chunks), len(writer.msgs))
	}
}

func TestHandleFileUpload_InvalidChunk(t *testing.T) {
	tmpDir := t.TempDir()
	uploadPath := filepath.Join(tmpDir, "bad.bin")

	writer := &testWriter{}
	env := &rt.Env{Conn: writer, Cfg: config.Config{}}
	ctx := context.Background()

	if err := HandleFileUpload(ctx, env, "cmd-bad", uploadPath, []byte("bad"), 5, 4, "bad-transfer"); err != nil {
		t.Fatalf("HandleFileUpload failed: %v", err)
	}

	if len(writer.msgs) != 1 {
		t.Fatalf("Expected 1 message, got %d", len(writer.msgs))
	}

	var result wire.FileUploadResult
	if err := msgpack.Unmarshal(writer.msgs[0], &result); err != nil {
		t.Fatalf("Failed to unmarshal result: %v", err)
	}
	if result.OK {
		t.Fatalf("Expected OK=false for invalid chunk")
	}
}

func TestHandleFileZip(t *testing.T) {

	tmpDir := t.TempDir()
	sourceDir := filepath.Join(tmpDir, "source")

	if err := os.Mkdir(sourceDir, 0755); err != nil {
		t.Fatalf("Failed to create source dir: %v", err)
	}

	testFile := filepath.Join(sourceDir, "test.txt")
	if err := os.WriteFile(testFile, []byte("zip me"), 0644); err != nil {
		t.Fatalf("Failed to create test file: %v", err)
	}

	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{},
	}

	ctx := context.Background()
	cmdID := "test-cmd-7"

	if err := HandleFileZip(ctx, env, cmdID, sourceDir); err != nil {
		t.Fatalf("HandleFileZip failed: %v", err)
	}

	if len(writer.msgs) == 0 {
		t.Fatal("Expected at least 1 message")
	}

	hasResult := false
	hasDownload := false

	for _, msg := range writer.msgs {
		var testMsg map[string]interface{}
		if err := msgpack.Unmarshal(msg, &testMsg); err == nil {
			msgType, _ := testMsg["type"].(string)
			if msgType == "command_result" {
				hasResult = true
			}
			if msgType == "file_download" {
				hasDownload = true
			}
		}
	}

	t.Logf("Has command_result: %v, has file_download: %v", hasResult, hasDownload)

	if !hasResult && !hasDownload {
		t.Error("Expected either command_result or file_download message")
	}
}

func TestHandleFileUploadHTTP(t *testing.T) {
	data := []byte("http-upload-payload")

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("x-overlord-client-id"); got != "client-abc" {
			t.Fatalf("expected x-overlord-client-id client-abc, got %q", got)
		}
		if got := r.Header.Get("x-agent-token"); got != "agent-token" {
			t.Fatalf("expected x-agent-token agent-token, got %q", got)
		}
		_, _ = w.Write(data)
	}))
	defer ts.Close()

	tmpDir := t.TempDir()
	destPath := filepath.Join(tmpDir, "uploaded-http.bin")

	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg: config.Config{
			ID:                    "client-abc",
			AgentToken:            "agent-token",
			TLSInsecureSkipVerify: true,
		},
	}

	if err := HandleFileUploadHTTP(context.Background(), env, "cmd-http-upload", destPath, ts.URL+"/file", int64(len(data))); err != nil {
		t.Fatalf("HandleFileUploadHTTP failed: %v", err)
	}

	content, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatalf("failed reading uploaded file: %v", err)
	}
	if !bytes.Equal(content, data) {
		t.Fatalf("uploaded content mismatch")
	}

	if len(writer.msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(writer.msgs))
	}
	var result wire.CommandResult
	if err := msgpack.Unmarshal(writer.msgs[0], &result); err != nil {
		t.Fatalf("failed to unmarshal command result: %v", err)
	}
	if !result.OK {
		t.Fatalf("expected OK=true, got false: %s", result.Message)
	}
}

func TestHandleFileUploadHTTP_ResumesWithRangeAfterShortRead(t *testing.T) {
	data := bytes.Repeat([]byte("range-retry-"), 128*1024)
	firstLen := len(data) / 3
	var requests int
	var sawRange string

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if requests == 1 {
			w.Header().Set("Content-Length", fmt.Sprintf("%d", len(data)))
			_, _ = w.Write(data[:firstLen])
			return
		}

		sawRange = r.Header.Get("Range")
		expectedRange := fmt.Sprintf("bytes=%d-", firstLen)
		if sawRange != expectedRange {
			t.Fatalf("expected resume range %q, got %q", expectedRange, sawRange)
		}
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(data)-firstLen))
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", firstLen, len(data)-1, len(data)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(data[firstLen:])
	}))
	defer ts.Close()

	tmpDir := t.TempDir()
	destPath := filepath.Join(tmpDir, "uploaded-http-resume.bin")

	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{TLSInsecureSkipVerify: true},
	}

	if err := HandleFileUploadHTTP(context.Background(), env, "cmd-http-upload-resume", destPath, ts.URL+"/file", int64(len(data))); err != nil {
		t.Fatalf("HandleFileUploadHTTP failed: %v", err)
	}

	if requests < 2 {
		t.Fatalf("expected retry request, got %d request(s)", requests)
	}
	if sawRange == "" {
		t.Fatal("expected retry request to include Range header")
	}

	content, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatalf("failed reading uploaded file: %v", err)
	}
	if !bytes.Equal(content, data) {
		t.Fatalf("uploaded content mismatch after resume")
	}

	if len(writer.msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(writer.msgs))
	}
	var result wire.CommandResult
	if err := msgpack.Unmarshal(writer.msgs[0], &result); err != nil {
		t.Fatalf("failed to unmarshal command result: %v", err)
	}
	if !result.OK {
		t.Fatalf("expected OK=true, got false: %s", result.Message)
	}
}

func TestHandleFileUploadHTTP_SizeMismatch(t *testing.T) {
	data := []byte("small")

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(data)
	}))
	defer ts.Close()

	tmpDir := t.TempDir()
	destPath := filepath.Join(tmpDir, "uploaded-http-mismatch.bin")

	writer := &testWriter{}
	env := &rt.Env{
		Conn: writer,
		Cfg:  config.Config{TLSInsecureSkipVerify: true},
	}

	if err := HandleFileUploadHTTP(context.Background(), env, "cmd-http-upload-mismatch", destPath, ts.URL+"/file", int64(len(data)+1)); err != nil {
		t.Fatalf("HandleFileUploadHTTP failed: %v", err)
	}

	if len(writer.msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(writer.msgs))
	}
	var result wire.CommandResult
	if err := msgpack.Unmarshal(writer.msgs[0], &result); err != nil {
		t.Fatalf("failed to unmarshal command result: %v", err)
	}
	if result.OK {
		t.Fatalf("expected OK=false for size mismatch")
	}
}
