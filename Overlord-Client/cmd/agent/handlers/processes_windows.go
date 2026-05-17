//go:build windows
// +build windows

package handlers

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"overlord-client/cmd/agent/wire"

	"golang.org/x/sys/windows"
)

var (
	modKernel32                  = windows.NewLazySystemDLL("kernel32.dll")
	modPsapi                     = windows.NewLazySystemDLL("psapi.dll")
	modNtdll                     = windows.NewLazySystemDLL("ntdll.dll")
	procEnumProcesses            = modPsapi.NewProc("EnumProcesses")
	procGetProcessMemoryInfo     = modPsapi.NewProc("GetProcessMemoryInfo")
	procOpenProcess              = modKernel32.NewProc("OpenProcess")
	procGetProcessImageFileNameW = modPsapi.NewProc("GetProcessImageFileNameW")
	procGetProcessTimes          = modKernel32.NewProc("GetProcessTimes")
)

type cpuSample struct {
	cpuTime100ns uint64
	sampledAt    time.Time
}

var (
	cpuSamplesMu sync.Mutex
	cpuSamples   = make(map[int32]cpuSample)
)

type PROCESS_MEMORY_COUNTERS struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

func listProcesses() ([]wire.ProcessInfo, error) {
	selfPID := int32(os.Getpid())
	numCPU := runtime.NumCPU()
	if numCPU < 1 {
		numCPU = 1
	}
	var pids [4096]uint32
	var bytesReturned uint32

	ret, _, _ := procEnumProcesses.Call(
		uintptr(unsafe.Pointer(&pids[0])),
		uintptr(len(pids)*4),
		uintptr(unsafe.Pointer(&bytesReturned)),
	)

	if ret == 0 {
		return nil, fmt.Errorf("EnumProcesses failed")
	}

	numProcesses := int(bytesReturned / 4)
	processes := make([]wire.ProcessInfo, 0, numProcesses)

	for i := 0; i < numProcesses; i++ {
		pid := int32(pids[i])
		if pid == 0 {
			continue
		}

		handle, _, _ := procOpenProcess.Call(
			windows.PROCESS_QUERY_INFORMATION|windows.PROCESS_VM_READ,
			0,
			uintptr(pid),
		)

		if handle == 0 {
			continue
		}
		defer windows.CloseHandle(windows.Handle(handle))

		var filename [windows.MAX_PATH]uint16
		ret, _, _ := procGetProcessImageFileNameW.Call(
			handle,
			uintptr(unsafe.Pointer(&filename[0])),
			uintptr(len(filename)),
		)

		name := "Unknown"
		if ret != 0 {
			name = syscall.UTF16ToString(filename[:])

			for i := len(name) - 1; i >= 0; i-- {
				if name[i] == '\\' || name[i] == '/' {
					name = name[i+1:]
					break
				}
			}
		}

		var memCounters PROCESS_MEMORY_COUNTERS
		memCounters.CB = uint32(unsafe.Sizeof(memCounters))
		memory := uint64(0)

		ret, _, _ = procGetProcessMemoryInfo.Call(
			handle,
			uintptr(unsafe.Pointer(&memCounters)),
			uintptr(memCounters.CB),
		)

		if ret != 0 {
			memory = uint64(memCounters.WorkingSetSize)
		}

		cpu := 0.0
		var creation, exit, kernel, user windows.Filetime
		ret, _, _ = procGetProcessTimes.Call(
			handle,
			uintptr(unsafe.Pointer(&creation)),
			uintptr(unsafe.Pointer(&exit)),
			uintptr(unsafe.Pointer(&kernel)),
			uintptr(unsafe.Pointer(&user)),
		)
		if ret != 0 {
			cpuTotal := (uint64(kernel.HighDateTime)<<32 | uint64(kernel.LowDateTime)) +
				(uint64(user.HighDateTime)<<32 | uint64(user.LowDateTime))
			now := time.Now()
			cpuSamplesMu.Lock()
			if prev, ok := cpuSamples[pid]; ok {
				wallDelta := now.Sub(prev.sampledAt).Seconds()
				if wallDelta > 0 && cpuTotal >= prev.cpuTime100ns {
					cpuDelta := float64(cpuTotal-prev.cpuTime100ns) / 1e7
					cpu = (cpuDelta / wallDelta) / float64(numCPU) * 100.0
					if cpu < 0 {
						cpu = 0
					} else if cpu > 100 {
						cpu = 100
					}
				}
			}
			cpuSamples[pid] = cpuSample{cpuTime100ns: cpuTotal, sampledAt: now}
			cpuSamplesMu.Unlock()
		}

		var pbi windows.PROCESS_BASIC_INFORMATION
		ppid := int32(0)
		err := windows.NtQueryInformationProcess(windows.Handle(handle), windows.ProcessBasicInformation, unsafe.Pointer(&pbi), uint32(unsafe.Sizeof(pbi)), nil)
		if err == nil {
			ppid = int32(pbi.InheritedFromUniqueProcessId)
		}

		username := "System"
		var token windows.Token
		if err := windows.OpenProcessToken(windows.Handle(handle), windows.TOKEN_QUERY, &token); err == nil {
			defer token.Close()
			tokenUser, err := token.GetTokenUser()
			if err == nil {
				account, domain, _, err := tokenUser.User.Sid.LookupAccount("")
				if err == nil {
					if domain != "" {
						username = domain + "\\" + account
					} else {
						username = account
					}
				}
			}
		}

		procType := "other"
		usernameLower := strings.ToLower(username)
		nameLower := strings.ToLower(name)

		if pid <= 4 || nameLower == "system" || nameLower == "registry" {
			procType = "system"
		} else if strings.Contains(usernameLower, "system") ||
			strings.Contains(usernameLower, "local service") ||
			strings.Contains(usernameLower, "network service") ||
			usernameLower == "system" {
			procType = "service"
		} else {

			currentUser, err := windows.GetCurrentProcessToken().GetTokenUser()
			if err == nil {
				tokenUser, err := token.GetTokenUser()
				if err == nil && tokenUser.User.Sid.Equals(currentUser.User.Sid) {
					procType = "own"
				}
			}
		}

		processes = append(processes, wire.ProcessInfo{
			PID:      pid,
			PPID:     ppid,
			Name:     name,
			CPU:      cpu,
			Memory:   memory,
			Username: username,
			Type:     procType,
			Self:     pid == selfPID,
		})
	}

	cpuSamplesMu.Lock()
	live := make(map[int32]struct{}, len(processes))
	for _, p := range processes {
		live[p.PID] = struct{}{}
	}
	for pid := range cpuSamples {
		if _, ok := live[pid]; !ok {
			delete(cpuSamples, pid)
		}
	}
	cpuSamplesMu.Unlock()

	return processes, nil
}

func killProcess(pid int32) error {
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)

	return windows.TerminateProcess(handle, 1)
}

func suspendProcess(pid int32) error {
	procNtSuspendProcess := modNtdll.NewProc("NtSuspendProcess")
	handle, err := windows.OpenProcess(windows.PROCESS_SUSPEND_RESUME, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)

	ret, _, _ := procNtSuspendProcess.Call(uintptr(handle))
	if ret != 0 {
		return fmt.Errorf("NtSuspendProcess failed with status 0x%x", ret)
	}
	return nil
}

func resumeProcess(pid int32) error {
	procNtResumeProcess := modNtdll.NewProc("NtResumeProcess")
	handle, err := windows.OpenProcess(windows.PROCESS_SUSPEND_RESUME, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)

	ret, _, _ := procNtResumeProcess.Call(uintptr(handle))
	if ret != 0 {
		return fmt.Errorf("NtResumeProcess failed with status 0x%x", ret)
	}
	return nil
}
