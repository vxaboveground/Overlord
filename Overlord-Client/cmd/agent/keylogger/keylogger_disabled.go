//go:build nokeylogger
// +build nokeylogger

package keylogger

import "time"

type Keylogger struct{}

type FileInfo struct {
	Name string
	Size int64
	Date time.Time
}

func New() *Keylogger { return nil }

func (k *Keylogger) Start() error              { return nil }
func (k *Keylogger) Stop()                     {}
func (k *Keylogger) ListFiles() ([]FileInfo, error) { return nil, nil }
func (k *Keylogger) ReadFile(string) ([]byte, error) { return nil, nil }
func (k *Keylogger) ClearAll() error           { return nil }
func (k *Keylogger) DeleteFile(string) error   { return nil }
func (k *Keylogger) FlushNow()                 {}
