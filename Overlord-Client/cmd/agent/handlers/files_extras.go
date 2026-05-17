package handlers

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"time"

	agentRuntime "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

func parseIconRequestItems(raw interface{}) []wire.FileIconRequestItem {
	arr, _ := raw.([]interface{})
	out := make([]wire.FileIconRequestItem, 0, len(arr))
	for _, v := range arr {
		m := coerceStringMap(v)
		if m == nil {
			continue
		}
		key, _ := m["key"].(string)
		if key == "" {
			continue
		}
		path, _ := m["path"].(string)
		ext, _ := m["ext"].(string)
		out = append(out, wire.FileIconRequestItem{Key: key, Path: path, Ext: ext})
	}
	return out
}

func parseThumbRequestItems(raw interface{}) []wire.FileThumbnailRequestItem {
	arr, _ := raw.([]interface{})
	out := make([]wire.FileThumbnailRequestItem, 0, len(arr))
	for _, v := range arr {
		m := coerceStringMap(v)
		if m == nil {
			continue
		}
		key, _ := m["key"].(string)
		path, _ := m["path"].(string)
		if key == "" || path == "" {
			continue
		}
		size := 0
		switch s := m["size"].(type) {
		case float64:
			size = int(s)
		case int64:
			size = int(s)
		case uint64:
			size = int(s)
		case int:
			size = s
		}
		out = append(out, wire.FileThumbnailRequestItem{Key: key, Path: path, Size: size})
	}
	return out
}

func coerceStringMap(v interface{}) map[string]interface{} {
	if m, ok := v.(map[string]interface{}); ok {
		return m
	}
	if m, ok := v.(map[interface{}]interface{}); ok {
		out := make(map[string]interface{}, len(m))
		for k, val := range m {
			if ks, ok := k.(string); ok {
				out[ks] = val
			}
		}
		return out
	}
	return nil
}

func HandleFileIcon(ctx context.Context, env *agentRuntime.Env, cmdID string, items []wire.FileIconRequestItem) error {
	out := make([]wire.FileIconResultItem, 0, len(items))
	for _, item := range items {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		png, err := extractFileIconPNG(item.Path, item.Ext)
		ri := wire.FileIconResultItem{Key: item.Key}
		if err != nil {
			ri.Error = err.Error()
		} else {
			ri.PNG = png
		}
		out = append(out, ri)
	}
	return wire.WriteMsg(ctx, env.Conn, wire.FileIconResult{
		Type:      "file_icon_result",
		CommandID: cmdID,
		Icons:     out,
	})
}

func HandleFileThumbnail(ctx context.Context, env *agentRuntime.Env, cmdID string, items []wire.FileThumbnailRequestItem) error {
	out := make([]wire.FileThumbnailResultItem, 0, len(items))
	for _, item := range items {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		jpegBytes, w, h, err := extractFileThumbnailJPEG(item.Path, item.Size)
		ri := wire.FileThumbnailResultItem{Key: item.Key}
		if err != nil {
			ri.Error = err.Error()
		} else {
			ri.JPEG = jpegBytes
			ri.W = w
			ri.H = h
		}
		out = append(out, ri)
	}
	return wire.WriteMsg(ctx, env.Conn, wire.FileThumbnailResult{
		Type:      "file_thumb_result",
		CommandID: cmdID,
		Thumbs:    out,
	})
}

func HandleFolderSize(ctx context.Context, env *agentRuntime.Env, cmdID string, path string) error {
	log.Printf("file_dirsize: %s", path)

	var bytes, files, dirs int64
	lastEmit := time.Now()

	emit := func(done bool, errMsg string) error {
		return wire.WriteMsg(ctx, env.Conn, wire.FolderSizeResult{
			Type:      "file_dirsize_result",
			CommandID: cmdID,
			Path:      path,
			Bytes:     bytes,
			Files:     files,
			Dirs:      dirs,
			Done:      done,
			Error:     errMsg,
		})
	}

	walkErr := filepath.Walk(path, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if info.IsDir() {
			dirs++
		} else {
			files++
			bytes += info.Size()
		}
		if time.Since(lastEmit) >= 400*time.Millisecond {
			lastEmit = time.Now()
			_ = emit(false, "")
		}
		return nil
	})

	errMsg := ""
	if walkErr != nil && walkErr != context.Canceled {
		errMsg = walkErr.Error()
	}
	return emit(true, errMsg)
}
