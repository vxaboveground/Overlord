package privacy

import (
	"sync"
	"sync/atomic"
)

const inputMarker uintptr = 0x00D5E7B00B5

type Manager struct {
	mu      sync.Mutex
	enabled int32
}

var global = &Manager{}

func Get() *Manager { return global }

func (m *Manager) IsEnabled() bool {
	return atomic.LoadInt32(&m.enabled) != 0
}

func (m *Manager) Enable() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if atomic.LoadInt32(&m.enabled) != 0 {
		return nil
	}

	if err := enablePlatform(); err != nil {
		atomic.StoreInt32(&m.enabled, 0)
		return err
	}

	atomic.StoreInt32(&m.enabled, 1)
	return nil
}

func (m *Manager) Disable() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if atomic.SwapInt32(&m.enabled, 0) == 0 {
		return
	}

	disablePlatform()
}

func Start() error         { return Get().Enable() }
func Stop()                { Get().Disable() }
func IsEnabled() bool      { return Get().IsEnabled() }
func InputMarker() uintptr { return inputMarker }
