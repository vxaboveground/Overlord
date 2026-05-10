//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// _memBasicInfo mirrors MEMORY_BASIC_INFORMATION for 64-bit Windows.
// Layout (bytes): BaseAddress(8) AllocationBase(8) AllocationProtect(4)
//   _pad(4) RegionSize(8) State(4) Protect(4) Type(4) _pad(4) = 48 bytes total.
type _memBasicInfo struct {
	BaseAddress       uintptr
	AllocationBase    uintptr
	AllocationProtect uint32
	_                 [4]byte // covers PartitionId / alignment padding
	RegionSize        uintptr
	State             uint32
	Protect           uint32
	Type              uint32
	_                 [4]byte
}

var (
	_k32mem   = syscall.NewLazyDLL("kernel32.dll")
	_vqProc   = _k32mem.NewProc("VirtualQuery")
	_memProbe byte // global in .data section — MEM_IMAGE when PE-loaded, MEM_PRIVATE as shellcode
)

// isRunningInMemory returns true when the agent's data section is in
// anonymous private memory (Donut-injected shellcode) rather than a
// file-backed image section.
func isRunningInMemory() bool {
	var mbi _memBasicInfo
	addr := uintptr(unsafe.Pointer(&_memProbe))
	ret, _, _ := _vqProc.Call(addr, uintptr(unsafe.Pointer(&mbi)), unsafe.Sizeof(mbi))
	if ret == 0 {
		return false
	}
	const MEM_IMAGE = 0x1000000
	return mbi.Type != MEM_IMAGE
}
