package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

const maxWASMFileReadBytes = 32 * 1024 * 1024

type wasmPlugin struct {
	ctx      context.Context
	cancel   context.CancelFunc
	runtime  wazero.Runtime
	module   api.Module
	manifest PluginManifest
	hostInfo []byte
	send     func(string, []byte)
	mu       sync.Mutex
	acl      map[string]map[string]bool
}

func loadWASMPlugin(parent context.Context, manifest PluginManifest, data []byte) (PluginRuntime, error) {
	if len(data) == 0 {
		return nil, errors.New("empty wasm plugin module")
	}
	ctx, cancel := context.WithCancel(parent)
	rt := wazero.NewRuntime(ctx)
	wp := &wasmPlugin{
		ctx:      ctx,
		cancel:   cancel,
		runtime:  rt,
		manifest: manifest,
		acl:      buildFileACL(manifest.Needs),
	}

	wasi_snapshot_preview1.MustInstantiate(ctx, rt)
	if err := wp.instantiateHostModule("env"); err != nil {
		cancel()
		_ = rt.Close(ctx)
		return nil, err
	}
	if err := wp.instantiateHostModule("overlord"); err != nil {
		cancel()
		_ = rt.Close(ctx)
		return nil, err
	}

	mod, err := rt.InstantiateWithConfig(ctx, data, wazero.NewModuleConfig().
		WithName(manifest.ID).
		WithStartFunctions("_initialize"))
	if err != nil {
		cancel()
		_ = rt.Close(ctx)
		return nil, fmt.Errorf("wasm instantiate: %w", err)
	}
	wp.module = mod
	return wp, nil
}

func (p *wasmPlugin) instantiateHostModule(name string) error {
	builder := p.runtime.NewHostModuleBuilder(name)
	export := func(name string, params []api.ValueType, results []api.ValueType, fn api.GoModuleFunc) {
		builder.NewFunctionBuilder().WithGoModuleFunction(fn, params, results).Export(name)
	}

	export("overlord_emit",
		[]api.ValueType{api.ValueTypeI32, api.ValueTypeI32, api.ValueTypeI32, api.ValueTypeI32},
		[]api.ValueType{api.ValueTypeI32},
		func(ctx context.Context, mod api.Module, stack []uint64) {
			event, ok := readWASMBytes(mod, uint32(stack[0]), uint32(stack[1]))
			if !ok {
				stack[0] = wasmStatus(statusInvalid)
				return
			}
			payload, ok := readWASMBytes(mod, uint32(stack[2]), uint32(stack[3]))
			if !ok {
				stack[0] = wasmStatus(statusInvalid)
				return
			}
			if p.send != nil {
				p.send(string(event), payload)
			}
			stack[0] = 0
		})
	export("overlord_host_info",
		[]api.ValueType{api.ValueTypeI32, api.ValueTypeI32},
		[]api.ValueType{api.ValueTypeI32},
		func(ctx context.Context, mod api.Module, stack []uint64) {
			stack[0] = wasmStatus(writeWASMOutput(mod, uint32(stack[0]), uint32(stack[1]), p.hostInfo))
		})

	export("overlord_fs_stat", fsReadParams(), []api.ValueType{api.ValueTypeI32}, p.fsStat)
	export("overlord_fs_list", fsReadParams(), []api.ValueType{api.ValueTypeI32}, p.fsList)
	export("overlord_fs_read", fsReadParams(), []api.ValueType{api.ValueTypeI32}, p.fsRead)
	export("overlord_fs_write",
		[]api.ValueType{api.ValueTypeI32, api.ValueTypeI32, api.ValueTypeI32, api.ValueTypeI32, api.ValueTypeI32, api.ValueTypeI32},
		[]api.ValueType{api.ValueTypeI32},
		p.fsWrite)
	export("overlord_fs_delete",
		[]api.ValueType{api.ValueTypeI32, api.ValueTypeI32, api.ValueTypeI32, api.ValueTypeI32},
		[]api.ValueType{api.ValueTypeI32},
		p.fsDelete)
	export("overlord_fs_mkdir",
		[]api.ValueType{api.ValueTypeI32, api.ValueTypeI32, api.ValueTypeI32, api.ValueTypeI32},
		[]api.ValueType{api.ValueTypeI32},
		p.fsMkdir)

	_, err := builder.Instantiate(p.ctx)
	return err
}

func fsReadParams() []api.ValueType {
	return []api.ValueType{
		api.ValueTypeI32, api.ValueTypeI32, // bucket
		api.ValueTypeI32, api.ValueTypeI32, // path
		api.ValueTypeI32, api.ValueTypeI32, // output buffer
	}
}

func (p *wasmPlugin) Load(send func(string, []byte), hostInfo []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.send = send
	p.hostInfo = append(p.hostInfo[:0], hostInfo...)
	return p.callBytes("overlord_on_load", hostInfo)
}

func (p *wasmPlugin) Event(event string, payload []byte) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	eventPtr, err := p.writeGuestBytes([]byte(event))
	if err != nil {
		return err
	}
	payloadPtr, err := p.writeGuestBytes(payload)
	if err != nil {
		p.freeGuestBytes(eventPtr, uint32(len(event)))
		return err
	}
	fn := p.module.ExportedFunction("overlord_on_event")
	if fn == nil {
		p.freeGuestBytes(eventPtr, uint32(len(event)))
		p.freeGuestBytes(payloadPtr, uint32(len(payload)))
		return errors.New("missing export: overlord_on_event")
	}
	results, err := fn.Call(p.ctx, uint64(eventPtr), uint64(len(event)), uint64(payloadPtr), uint64(len(payload)))
	p.freeGuestBytes(eventPtr, uint32(len(event)))
	p.freeGuestBytes(payloadPtr, uint32(len(payload)))
	if err != nil {
		return err
	}
	if len(results) > 0 && int32(uint32(results[0])) != 0 {
		return fmt.Errorf("overlord_on_event returned %d", int32(uint32(results[0])))
	}
	return nil
}

func (p *wasmPlugin) Unload() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.module == nil {
		return
	}
	if fn := p.module.ExportedFunction("overlord_on_unload"); fn != nil {
		_, _ = fn.Call(p.ctx)
	}
}

func (p *wasmPlugin) Close() error {
	p.Unload()
	p.cancel()
	if p.runtime != nil {
		return p.runtime.Close(context.Background())
	}
	return nil
}

func (p *wasmPlugin) Runtime() string {
	return "wasm"
}

func (p *wasmPlugin) callBytes(export string, data []byte) error {
	ptr, err := p.writeGuestBytes(data)
	if err != nil {
		return err
	}
	defer p.freeGuestBytes(ptr, uint32(len(data)))
	fn := p.module.ExportedFunction(export)
	if fn == nil {
		return fmt.Errorf("missing export: %s", export)
	}
	results, err := fn.Call(p.ctx, uint64(ptr), uint64(len(data)))
	if err != nil {
		return err
	}
	if len(results) > 0 && int32(uint32(results[0])) != 0 {
		return fmt.Errorf("%s returned %d", export, int32(uint32(results[0])))
	}
	return nil
}

func (p *wasmPlugin) writeGuestBytes(data []byte) (uint32, error) {
	alloc := p.module.ExportedFunction("overlord_alloc")
	if alloc == nil {
		return 0, errors.New("missing export: overlord_alloc")
	}
	results, err := alloc.Call(p.ctx, uint64(len(data)))
	if err != nil {
		return 0, err
	}
	if len(results) == 0 || uint32(results[0]) == 0 {
		return 0, errors.New("overlord_alloc returned null")
	}
	ptr := uint32(results[0])
	if len(data) > 0 && !p.module.Memory().Write(ptr, data) {
		p.freeGuestBytes(ptr, uint32(len(data)))
		return 0, errors.New("wasm memory write failed")
	}
	return ptr, nil
}

func (p *wasmPlugin) freeGuestBytes(ptr uint32, size uint32) {
	if ptr == 0 {
		return
	}
	if free := p.module.ExportedFunction("overlord_free"); free != nil {
		_, _ = free.Call(p.ctx, uint64(ptr), uint64(size))
	}
}

type wasmFileStat struct {
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"`
	Mode    string `json:"mode"`
}

func (p *wasmPlugin) fsStat(ctx context.Context, mod api.Module, stack []uint64) {
	target, status := p.resolveFromStack(mod, stack, "read")
	if status != statusOK {
		stack[0] = wasmStatus(status)
		return
	}
	st, err := os.Stat(target)
	if err != nil {
		stack[0] = wasmStatus(statusNotFound)
		return
	}
	info := wasmFileStat{Path: target, IsDir: st.IsDir(), Size: st.Size(), ModTime: st.ModTime().UnixMilli(), Mode: st.Mode().String()}
	p.writeJSONResult(mod, stack, info)
}

func (p *wasmPlugin) fsList(ctx context.Context, mod api.Module, stack []uint64) {
	target, status := p.resolveFromStack(mod, stack, "list")
	if status != statusOK {
		stack[0] = wasmStatus(status)
		return
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		stack[0] = wasmStatus(statusIO)
		return
	}
	out := make([]wasmFileStat, 0, len(entries))
	for _, ent := range entries {
		st, err := ent.Info()
		if err != nil {
			continue
		}
		out = append(out, wasmFileStat{Path: ent.Name(), IsDir: ent.IsDir(), Size: st.Size(), ModTime: st.ModTime().UnixMilli(), Mode: st.Mode().String()})
	}
	p.writeJSONResult(mod, stack, out)
}

func (p *wasmPlugin) fsRead(ctx context.Context, mod api.Module, stack []uint64) {
	target, status := p.resolveFromStack(mod, stack, "read")
	if status != statusOK {
		stack[0] = wasmStatus(status)
		return
	}
	st, err := os.Stat(target)
	if err != nil || st.IsDir() {
		stack[0] = wasmStatus(statusNotFound)
		return
	}
	if st.Size() > maxWASMFileReadBytes {
		stack[0] = wasmStatus(statusTooLarge)
		return
	}
	data, err := os.ReadFile(target)
	if err != nil {
		stack[0] = wasmStatus(statusIO)
		return
	}
	stack[0] = wasmStatus(writeWASMOutput(mod, uint32(stack[4]), uint32(stack[5]), data))
}

func (p *wasmPlugin) fsWrite(ctx context.Context, mod api.Module, stack []uint64) {
	target, status := p.resolvePath(mod, uint32(stack[0]), uint32(stack[1]), uint32(stack[2]), uint32(stack[3]), "write")
	if status != statusOK {
		stack[0] = wasmStatus(status)
		return
	}
	data, ok := readWASMBytes(mod, uint32(stack[4]), uint32(stack[5]))
	if !ok {
		stack[0] = wasmStatus(statusInvalid)
		return
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		stack[0] = wasmStatus(statusIO)
		return
	}
	if err := os.WriteFile(target, data, 0o600); err != nil {
		stack[0] = wasmStatus(statusIO)
		return
	}
	stack[0] = 0
}

func (p *wasmPlugin) fsDelete(ctx context.Context, mod api.Module, stack []uint64) {
	target, status := p.resolvePath(mod, uint32(stack[0]), uint32(stack[1]), uint32(stack[2]), uint32(stack[3]), "delete")
	if status != statusOK {
		stack[0] = wasmStatus(status)
		return
	}
	if err := os.RemoveAll(target); err != nil {
		stack[0] = wasmStatus(statusIO)
		return
	}
	stack[0] = 0
}

func (p *wasmPlugin) fsMkdir(ctx context.Context, mod api.Module, stack []uint64) {
	target, status := p.resolvePath(mod, uint32(stack[0]), uint32(stack[1]), uint32(stack[2]), uint32(stack[3]), "mkdir")
	if status != statusOK {
		stack[0] = wasmStatus(status)
		return
	}
	if err := os.MkdirAll(target, 0o700); err != nil {
		stack[0] = wasmStatus(statusIO)
		return
	}
	stack[0] = 0
}

func (p *wasmPlugin) resolveFromStack(mod api.Module, stack []uint64, op string) (string, int32) {
	return p.resolvePath(mod, uint32(stack[0]), uint32(stack[1]), uint32(stack[2]), uint32(stack[3]), op)
}

func (p *wasmPlugin) resolvePath(mod api.Module, bucketPtr, bucketLen, pathPtr, pathLen uint32, op string) (string, int32) {
	bucketBytes, ok := readWASMBytes(mod, bucketPtr, bucketLen)
	if !ok {
		return "", statusInvalid
	}
	pathBytes, ok := readWASMBytes(mod, pathPtr, pathLen)
	if !ok {
		return "", statusInvalid
	}
	bucket := string(bucketBytes)
	rel := string(pathBytes)
	if !p.acl[bucket][op] {
		return "", statusDenied
	}
	return resolvePluginBucketPath(p.manifest.ID, bucket, rel)
}

func resolvePluginBucketPath(pluginID, bucket, rel string) (string, int32) {
	if strings.ContainsRune(rel, 0) {
		return "", statusInvalid
	}
	if bucket == "fullDisk" {
		if rel == "" {
			if filepath.Separator == '\\' {
				return filepath.VolumeName(os.TempDir()) + string(filepath.Separator), statusOK
			}
			return string(filepath.Separator), statusOK
		}
		if !filepath.IsAbs(rel) {
			if filepath.Separator == '\\' {
				rel = filepath.VolumeName(os.TempDir()) + string(filepath.Separator) + rel
			} else {
				rel = string(filepath.Separator) + rel
			}
		}
		return filepath.Clean(rel), statusOK
	}
	root, ok := bucketRoot(pluginID, bucket)
	if !ok {
		return "", statusDenied
	}
	if filepath.IsAbs(rel) || strings.HasPrefix(rel, string(filepath.Separator)) || strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, `\`) {
		return "", statusDenied
	}
	cleanRel := strings.TrimPrefix(filepath.Clean(string(filepath.Separator)+rel), string(filepath.Separator))
	target := filepath.Join(root, cleanRel)
	resolvedRoot, err := filepath.Abs(root)
	if err != nil {
		return "", statusIO
	}
	resolvedTarget, err := filepath.Abs(target)
	if err != nil {
		return "", statusIO
	}
	r, err := filepath.Rel(resolvedRoot, resolvedTarget)
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", statusDenied
	}
	return resolvedTarget, statusOK
}

func bucketRoot(pluginID, bucket string) (string, bool) {
	home, _ := os.UserHomeDir()
	switch bucket {
	case "home":
		return home, home != ""
	case "desktop":
		return filepath.Join(home, "Desktop"), home != ""
	case "documents":
		return filepath.Join(home, "Documents"), home != ""
	case "downloads":
		return filepath.Join(home, "Downloads"), home != ""
	case "temp":
		return os.TempDir(), true
	case "appData":
		dir, err := os.UserConfigDir()
		if err != nil {
			return "", false
		}
		return filepath.Join(dir, "Overlord"), true
	case "pluginData":
		dir, err := os.UserConfigDir()
		if err != nil {
			return "", false
		}
		root := filepath.Join(dir, "Overlord", "plugins", pluginID)
		_ = os.MkdirAll(root, 0o700)
		return root, true
	default:
		return "", false
	}
}

func buildFileACL(needs PluginNeeds) map[string]map[string]bool {
	acl := map[string]map[string]bool{}
	for _, need := range needs.Files {
		if acl[need.Bucket] == nil {
			acl[need.Bucket] = map[string]bool{}
		}
		for _, op := range need.Access {
			acl[need.Bucket][op] = true
		}
	}
	return acl
}

func (p *wasmPlugin) writeJSONResult(mod api.Module, stack []uint64, v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		stack[0] = wasmStatus(statusIO)
		return
	}
	stack[0] = wasmStatus(writeWASMOutput(mod, uint32(stack[4]), uint32(stack[5]), data))
}

func readWASMBytes(mod api.Module, ptr, size uint32) ([]byte, bool) {
	if size == 0 {
		return nil, true
	}
	data, ok := mod.Memory().Read(ptr, size)
	if !ok {
		return nil, false
	}
	out := make([]byte, len(data))
	copy(out, data)
	return out, true
}

func writeWASMOutput(mod api.Module, ptr, size uint32, data []byte) int32 {
	if uint32(len(data)) > size {
		return statusTooSmall
	}
	if len(data) > 0 && !mod.Memory().Write(ptr, data) {
		return statusInvalid
	}
	return int32(len(data))
}

const (
	statusOK       int32 = 0
	statusDenied   int32 = -1
	statusInvalid  int32 = -2
	statusNotFound int32 = -3
	statusTooSmall int32 = -4
	statusTooLarge int32 = -5
	statusIO       int32 = -6
)

func wasmStatus(status int32) uint64 {
	return uint64(uint32(status))
}
