//go:build windows

package plugins

import (
	"errors"
	"fmt"
	"overlord-client/cmd/agent/plugins/teb"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	imageDOSSignature = 0x5A4D     // "MZ"
	imageNTSignature  = 0x00004550 // "PE\0\0"

	imageOptionalHdrMagicPE32Plus = 0x20B

	imageDirectoryEntryExport    = 0
	imageDirectoryEntryImport    = 1
	imageDirectoryEntryBaseReloc = 5
	imageDirectoryEntryTLS       = 9

	imageRelBasedDir64    = 10
	imageRelBasedHighLow  = 3
	imageRelBasedAbsolute = 0

	imageSCNMemExecute = 0x20000000
	imageSCNMemRead    = 0x40000000
	imageSCNMemWrite   = 0x80000000

	dllProcessAttach = 1
	dllProcessDetach = 0
)

type imageDOSHeader struct {
	Magic  uint16
	_      [28]uint16
	LfaNew int32
}

type imageFileHeader struct {
	Machine              uint16
	NumberOfSections     uint16
	TimeDateStamp        uint32
	PointerToSymbolTable uint32
	NumberOfSymbols      uint32
	SizeOfOptionalHeader uint16
	Characteristics      uint16
}

type imageDataDirectory struct {
	VirtualAddress uint32
	Size           uint32
}

type imageOptionalHeader64 struct {
	Magic               uint16
	_                   [14]byte
	AddressOfEntryPoint uint32
	_                   [4]byte
	ImageBase           uint64
	SectionAlignment    uint32
	FileAlignment       uint32
	_                   [16]byte
	SizeOfImage         uint32
	SizeOfHeaders       uint32
	_                   [4]byte
	_                   [4]byte // Subsystem + DllCharacteristics
	_                   [36]byte
	NumberOfRvaAndSizes uint32
	DataDirectory       [16]imageDataDirectory
}

type imageNTHeaders64 struct {
	Signature      uint32
	FileHeader     imageFileHeader
	OptionalHeader imageOptionalHeader64
}

type imageSectionHeader struct {
	Name             [8]byte
	VirtualSize      uint32
	VirtualAddress   uint32
	SizeOfRawData    uint32
	PointerToRawData uint32
	_                [12]byte
	Characteristics  uint32
}

type imageImportDescriptor struct {
	OriginalFirstThunk uint32
	TimeDateStamp      uint32
	ForwarderChain     uint32
	Name               uint32
	FirstThunk         uint32
}

type imageBaseRelocation struct {
	VirtualAddress uint32
	SizeOfBlock    uint32
}

type imageExportDirectory struct {
	_                     [12]byte
	Name                  uint32
	Base                  uint32
	NumberOfFunctions     uint32
	NumberOfNames         uint32
	AddressOfFunctions    uint32
	AddressOfNames        uint32
	AddressOfNameOrdinals uint32
}

type imageTLSDirectory64 struct {
	StartAddressOfRawData uint64
	EndAddressOfRawData   uint64
	AddressOfIndex        uint64
	AddressOfCallBacks    uint64
	SizeOfZeroFill        uint32
	Characteristics       uint32
}

type MemoryModule struct {
	base          uintptr
	size          uintptr
	entryPoint    uintptr
	exports       map[string]uintptr
	importDLLs    []windows.Handle
	initialized   bool
	tlsIndex      uint32
	tlsData       uintptr
	tlsArrayAlloc uintptr // our VirtualAlloc'd ThreadLocalStoragePointer array
	tlsTemplSrc   uintptr // PE template raw data start (for copying to new threads)
	tlsTemplSize  uintptr // dataSize (template bytes to copy)
	tlsTotalSize  uintptr // dataSize + zeroFill (total allocation per thread)
}

func LoadMemoryModule(data []byte) (*MemoryModule, error) {
	if len(data) < int(unsafe.Sizeof(imageDOSHeader{})) {
		return nil, errors.New("pe: data too small for DOS header")
	}

	dosHdr := (*imageDOSHeader)(unsafe.Pointer(&data[0]))
	if dosHdr.Magic != imageDOSSignature {
		return nil, errors.New("pe: invalid DOS signature")
	}

	ntOffset := int(dosHdr.LfaNew)
	if ntOffset < 0 || ntOffset+int(unsafe.Sizeof(imageNTHeaders64{})) > len(data) {
		return nil, errors.New("pe: NT headers out of bounds")
	}
	ntHdr := (*imageNTHeaders64)(unsafe.Pointer(&data[ntOffset]))
	if ntHdr.Signature != imageNTSignature {
		return nil, errors.New("pe: invalid NT signature")
	}
	if ntHdr.OptionalHeader.Magic != imageOptionalHdrMagicPE32Plus {
		return nil, errors.New("pe: only PE32+ (64-bit) is supported")
	}

	imageSize := uintptr(ntHdr.OptionalHeader.SizeOfImage)
	preferredBase := uintptr(ntHdr.OptionalHeader.ImageBase)

	base, err := windows.VirtualAlloc(preferredBase, imageSize, windows.MEM_RESERVE|windows.MEM_COMMIT, windows.PAGE_READWRITE)
	if err != nil || base == 0 {
		base, err = windows.VirtualAlloc(0, imageSize, windows.MEM_RESERVE|windows.MEM_COMMIT, windows.PAGE_READWRITE)
		if err != nil {
			return nil, fmt.Errorf("pe: VirtualAlloc failed: %w", err)
		}
	}

	mm := &MemoryModule{
		base:     base,
		size:     imageSize,
		exports:  make(map[string]uintptr),
		tlsIndex: 0xFFFFFFFF,
	}

	headerSize := uintptr(ntHdr.OptionalHeader.SizeOfHeaders)
	if headerSize > uintptr(len(data)) {
		headerSize = uintptr(len(data))
	}
	copyMem(base, &data[0], headerSize)

	sectionStart := ntOffset + int(unsafe.Sizeof(ntHdr.Signature)) +
		int(unsafe.Sizeof(ntHdr.FileHeader)) +
		int(ntHdr.FileHeader.SizeOfOptionalHeader)

	for i := 0; i < int(ntHdr.FileHeader.NumberOfSections); i++ {
		off := sectionStart + i*int(unsafe.Sizeof(imageSectionHeader{}))
		if off+int(unsafe.Sizeof(imageSectionHeader{})) > len(data) {
			mm.Free()
			return nil, errors.New("pe: section header out of bounds")
		}
		sec := (*imageSectionHeader)(unsafe.Pointer(&data[off]))
		if sec.SizeOfRawData > 0 {
			rawOff := int(sec.PointerToRawData)
			rawEnd := rawOff + int(sec.SizeOfRawData)
			if rawEnd > len(data) {
				mm.Free()
				return nil, errors.New("pe: section raw data out of bounds")
			}
			copySize := uintptr(sec.SizeOfRawData)
			if sec.VirtualSize > 0 && uintptr(sec.VirtualSize) < copySize {
				copySize = uintptr(sec.VirtualSize)
			}
			dest := uintptr(sec.VirtualAddress)
			if dest+copySize > imageSize {
				if dest >= imageSize {
					continue
				}
				copySize = imageSize - dest
			}
			copyMem(base+dest, &data[rawOff], copySize)
		}
	}

	mappedNT := (*imageNTHeaders64)(unsafe.Pointer(base + uintptr(dosHdr.LfaNew)))
	delta := int64(base) - int64(mappedNT.OptionalHeader.ImageBase)

	if delta != 0 {
		relocDir := mappedNT.OptionalHeader.DataDirectory[imageDirectoryEntryBaseReloc]
		if relocDir.VirtualAddress != 0 && relocDir.Size != 0 {
			if err := mm.processRelocations(relocDir, delta); err != nil {
				mm.Free()
				return nil, err
			}
		}
	}

	importDir := mappedNT.OptionalHeader.DataDirectory[imageDirectoryEntryImport]
	if importDir.VirtualAddress != 0 && importDir.Size != 0 {
		if err := mm.resolveImports(importDir); err != nil {
			mm.Free()
			return nil, err
		}
	}

	for i := 0; i < int(ntHdr.FileHeader.NumberOfSections); i++ {
		off := sectionStart + i*int(unsafe.Sizeof(imageSectionHeader{}))
		sec := (*imageSectionHeader)(unsafe.Pointer(&data[off]))
		prot := sectionProtection(sec.Characteristics)
		size := uintptr(sec.VirtualSize)
		if size == 0 {
			size = uintptr(sec.SizeOfRawData)
		}
		if size == 0 {
			continue
		}
		var oldProt uint32
		_ = windows.VirtualProtect(base+uintptr(sec.VirtualAddress), size, prot, &oldProt)
	}

	mm.setupTLS(dllProcessAttach)

	if mappedNT.OptionalHeader.AddressOfEntryPoint != 0 {
		mm.entryPoint = base + uintptr(mappedNT.OptionalHeader.AddressOfEntryPoint)
	}

	exportDir := mappedNT.OptionalHeader.DataDirectory[imageDirectoryEntryExport]
	if exportDir.VirtualAddress != 0 && exportDir.Size != 0 {
		mm.parseExports(exportDir)
	}

	return mm, nil
}

func (mm *MemoryModule) CallEntryPoint(reason uint32) error {
	if mm.entryPoint == 0 {
		return nil
	}
	ret, _, _ := syscall.SyscallN(mm.entryPoint, mm.base, uintptr(reason), 0)
	if ret == 0 && reason == dllProcessAttach {
		return errors.New("pe: DllMain returned FALSE")
	}
	mm.initialized = (reason == dllProcessAttach)
	return nil
}

func (mm *MemoryModule) GetExport(name string) (uintptr, error) {
	addr, ok := mm.exports[name]
	if !ok {
		return 0, fmt.Errorf("pe: export %q not found", name)
	}
	return addr, nil
}

func (mm *MemoryModule) Free() {
	if mm.base == 0 {
		return
	}
	if mm.initialized && mm.entryPoint != 0 {
		syscall.SyscallN(mm.entryPoint, mm.base, dllProcessDetach, 0)
		mm.initialized = false
	}
	if mm.tlsIndex != 0xFFFFFFFF {
		if mm.tlsData != 0 {
			_ = windows.VirtualFree(mm.tlsData, 0, windows.MEM_RELEASE)
			mm.tlsData = 0
		}
	}
	for _, h := range mm.importDLLs {
		_ = windows.FreeLibrary(h)
	}
	mm.importDLLs = nil
	_ = windows.VirtualFree(mm.base, 0, windows.MEM_RELEASE)
	mm.base = 0
}

func (mm *MemoryModule) processRelocations(dir imageDataDirectory, delta int64) error {
	offset := uintptr(dir.VirtualAddress)
	end := offset + uintptr(dir.Size)

	for offset < end {
		block := (*imageBaseRelocation)(unsafe.Pointer(mm.base + offset))
		if block.SizeOfBlock == 0 {
			break
		}
		count := (block.SizeOfBlock - 8) / 2
		entries := mm.base + offset + 8

		for i := uint32(0); i < count; i++ {
			entry := *(*uint16)(unsafe.Pointer(entries + uintptr(i)*2))
			typ := entry >> 12
			off := uintptr(entry & 0xFFF)
			addr := mm.base + uintptr(block.VirtualAddress) + off

			switch typ {
			case imageRelBasedAbsolute:
			case imageRelBasedHighLow:
				val := (*uint32)(unsafe.Pointer(addr))
				*val = uint32(int64(*val) + delta)
			case imageRelBasedDir64:
				val := (*uint64)(unsafe.Pointer(addr))
				*val = uint64(int64(*val) + delta)
			default:
				return fmt.Errorf("pe: unsupported relocation type %d", typ)
			}
		}
		offset += uintptr(block.SizeOfBlock)
	}
	return nil
}

func (mm *MemoryModule) resolveImports(dir imageDataDirectory) error {
	descSize := unsafe.Sizeof(imageImportDescriptor{})
	offset := uintptr(dir.VirtualAddress)

	for {
		desc := (*imageImportDescriptor)(unsafe.Pointer(mm.base + offset))
		if desc.Name == 0 {
			break
		}

		dllName := peString(mm.base + uintptr(desc.Name))
		hDLL, err := windows.LoadLibrary(dllName)
		if err != nil {
			return fmt.Errorf("pe: LoadLibrary(%s): %w", dllName, err)
		}
		mm.importDLLs = append(mm.importDLLs, hDLL)

		thunkRef := mm.base + uintptr(desc.OriginalFirstThunk)
		thunkAddr := mm.base + uintptr(desc.FirstThunk)
		if desc.OriginalFirstThunk == 0 {
			thunkRef = thunkAddr
		}

		for {
			ref := *(*uint64)(unsafe.Pointer(thunkRef))
			if ref == 0 {
				break
			}

			var procAddr uintptr
			if ref&(1<<63) != 0 {
				ordinal := uint16(ref & 0xFFFF)
				procAddr, err = getProcByOrdinal(hDLL, ordinal)
			} else {
				nameAddr := mm.base + uintptr(ref) + 2
				funcName := peString(nameAddr)
				procAddr, err = windows.GetProcAddress(hDLL, funcName)
			}
			if err != nil {
				return fmt.Errorf("pe: import resolve from %s: %w", dllName, err)
			}

			*(*uintptr)(unsafe.Pointer(thunkAddr)) = procAddr
			thunkRef += 8
			thunkAddr += 8
		}
		offset += descSize
	}
	return nil
}

func (mm *MemoryModule) parseExports(dir imageDataDirectory) {
	if dir.Size == 0 {
		return
	}
	expDir := (*imageExportDirectory)(unsafe.Pointer(mm.base + uintptr(dir.VirtualAddress)))
	numNames := int(expDir.NumberOfNames)
	if numNames == 0 {
		return
	}

	namesRVA := mm.base + uintptr(expDir.AddressOfNames)
	ordinalsRVA := mm.base + uintptr(expDir.AddressOfNameOrdinals)
	funcsRVA := mm.base + uintptr(expDir.AddressOfFunctions)

	exportStart := uintptr(dir.VirtualAddress)
	exportEnd := exportStart + uintptr(dir.Size)

	for i := 0; i < numNames; i++ {
		nameRVA := *(*uint32)(unsafe.Pointer(namesRVA + uintptr(i)*4))
		ordinal := *(*uint16)(unsafe.Pointer(ordinalsRVA + uintptr(i)*2))
		funcRVA := *(*uint32)(unsafe.Pointer(funcsRVA + uintptr(ordinal)*4))

		if uintptr(funcRVA) >= exportStart && uintptr(funcRVA) < exportEnd {
			continue
		}

		name := peString(mm.base + uintptr(nameRVA))
		mm.exports[name] = mm.base + uintptr(funcRVA)
	}
}

func (mm *MemoryModule) setupTLS(reason uint32) {
	dosHdr := (*imageDOSHeader)(unsafe.Pointer(mm.base))
	ntHdr := (*imageNTHeaders64)(unsafe.Pointer(mm.base + uintptr(dosHdr.LfaNew)))
	tlsDir := ntHdr.OptionalHeader.DataDirectory[imageDirectoryEntryTLS]
	if tlsDir.VirtualAddress == 0 || tlsDir.Size == 0 {
		return
	}

	tls := (*imageTLSDirectory64)(unsafe.Pointer(mm.base + uintptr(tlsDir.VirtualAddress)))

	dataSize := uintptr(tls.EndAddressOfRawData - tls.StartAddressOfRawData)
	totalSize := dataSize + uintptr(tls.SizeOfZeroFill)

	var tlsData uintptr
	if totalSize > 0 {
		var err error
		tlsData, err = windows.VirtualAlloc(0, totalSize,
			windows.MEM_RESERVE|windows.MEM_COMMIT, windows.PAGE_READWRITE)
		if err != nil || tlsData == 0 {
			return
		}
		if dataSize > 0 {
			copyMem(tlsData, (*byte)(unsafe.Pointer(uintptr(tls.StartAddressOfRawData))), dataSize)
		}
	}

	tebAddr := teb.CurrentTEB()
	tlsArrayField := (*uintptr)(unsafe.Pointer(tebAddr + 0x58)) // ThreadLocalStoragePointer
	oldArray := *tlsArrayField

	var newIndex uint32
	ptrSize := unsafe.Sizeof(uintptr(0))

	if oldArray == 0 {
		newArray, err := windows.VirtualAlloc(0, ptrSize,
			windows.MEM_RESERVE|windows.MEM_COMMIT, windows.PAGE_READWRITE)
		if err != nil || newArray == 0 {
			if tlsData != 0 {
				_ = windows.VirtualFree(tlsData, 0, windows.MEM_RELEASE)
			}
			return
		}
		*(*uintptr)(unsafe.Pointer(newArray)) = tlsData
		*tlsArrayField = newArray
		newIndex = 0
		mm.tlsArrayAlloc = newArray
	} else {
		var count uint32
		for count = 0; count < 256; count++ {
			entry := *(*uintptr)(unsafe.Pointer(oldArray + uintptr(count)*ptrSize))
			if entry == 0 {
				break
			}
		}
		newSize := uintptr(count+1) * ptrSize
		newArray, err := windows.VirtualAlloc(0, newSize,
			windows.MEM_RESERVE|windows.MEM_COMMIT, windows.PAGE_READWRITE)
		if err != nil || newArray == 0 {
			if tlsData != 0 {
				_ = windows.VirtualFree(tlsData, 0, windows.MEM_RELEASE)
			}
			return
		}
		if count > 0 {
			copyMem(newArray, (*byte)(unsafe.Pointer(oldArray)), uintptr(count)*ptrSize)
		}
		*(*uintptr)(unsafe.Pointer(newArray + uintptr(count)*ptrSize)) = tlsData
		*tlsArrayField = newArray
		newIndex = count
		mm.tlsArrayAlloc = newArray
	}

	if tls.AddressOfIndex != 0 {
		*(*uint32)(unsafe.Pointer(uintptr(tls.AddressOfIndex))) = newIndex
	}

	mm.tlsIndex = newIndex
	mm.tlsData = tlsData
	mm.tlsTemplSrc = uintptr(tls.StartAddressOfRawData)
	mm.tlsTemplSize = dataSize
	mm.tlsTotalSize = totalSize

	if tls.AddressOfCallBacks != 0 {
		cbAddr := uintptr(tls.AddressOfCallBacks)
		for {
			cb := *(*uintptr)(unsafe.Pointer(cbAddr))
			if cb == 0 {
				break
			}
			syscall.SyscallN(cb, mm.base, uintptr(reason), 0)
			cbAddr += 8
		}
	}
}

func (mm *MemoryModule) SetupThreadTLS() func() {
	if mm.tlsIndex == 0xFFFFFFFF || mm.tlsTotalSize == 0 {
		return func() {}
	}

	tlsData, err := windows.VirtualAlloc(0, mm.tlsTotalSize,
		windows.MEM_RESERVE|windows.MEM_COMMIT, windows.PAGE_READWRITE)
	if err != nil || tlsData == 0 {
		return func() {}
	}
	if mm.tlsTemplSize > 0 {
		copyMem(tlsData, (*byte)(unsafe.Pointer(mm.tlsTemplSrc)), mm.tlsTemplSize)
	}

	ptrSize := unsafe.Sizeof(uintptr(0))
	tebAddr := teb.CurrentTEB()
	tlsArrayField := (*uintptr)(unsafe.Pointer(tebAddr + 0x58))
	oldArray := *tlsArrayField

	var newArray uintptr
	if oldArray == 0 {
		arrSize := uintptr(mm.tlsIndex+1) * ptrSize
		newArray, err = windows.VirtualAlloc(0, arrSize,
			windows.MEM_RESERVE|windows.MEM_COMMIT, windows.PAGE_READWRITE)
		if err != nil || newArray == 0 {
			_ = windows.VirtualFree(tlsData, 0, windows.MEM_RELEASE)
			return func() {}
		}
		*(*uintptr)(unsafe.Pointer(newArray + uintptr(mm.tlsIndex)*ptrSize)) = tlsData
		*tlsArrayField = newArray
	} else {
		needed := uintptr(mm.tlsIndex+1) * ptrSize
		newArray, err = windows.VirtualAlloc(0, needed,
			windows.MEM_RESERVE|windows.MEM_COMMIT, windows.PAGE_READWRITE)
		if err != nil || newArray == 0 {
			_ = windows.VirtualFree(tlsData, 0, windows.MEM_RELEASE)
			return func() {}
		}
		copyMem(newArray, (*byte)(unsafe.Pointer(oldArray)), needed)
		*(*uintptr)(unsafe.Pointer(newArray + uintptr(mm.tlsIndex)*ptrSize)) = tlsData
		*tlsArrayField = newArray
	}

	return func() {
		_ = windows.VirtualFree(tlsData, 0, windows.MEM_RELEASE)
		if newArray != 0 {
			*(*uintptr)(unsafe.Pointer(newArray + uintptr(mm.tlsIndex)*ptrSize)) = 0
			_ = windows.VirtualFree(newArray, 0, windows.MEM_RELEASE)
		}
		tebNow := teb.CurrentTEB()
		field := (*uintptr)(unsafe.Pointer(tebNow + 0x58))
		*field = oldArray
	}
}

func peString(addr uintptr) string {
	var buf []byte
	for i := 0; i < 4096; i++ { // safety limit
		b := *(*byte)(unsafe.Pointer(addr + uintptr(i)))
		if b == 0 {
			break
		}
		buf = append(buf, b)
	}
	return string(buf)
}

func copyMem(dst uintptr, src *byte, size uintptr) {
	for i := uintptr(0); i < size; i++ {
		*(*byte)(unsafe.Pointer(dst + i)) = *(*byte)(unsafe.Pointer(uintptr(unsafe.Pointer(src)) + i))
	}
}

func sectionProtection(chars uint32) uint32 {
	r := chars&imageSCNMemRead != 0
	w := chars&imageSCNMemWrite != 0
	x := chars&imageSCNMemExecute != 0

	switch {
	case x && w:
		return windows.PAGE_EXECUTE_READWRITE
	case x && r:
		return windows.PAGE_EXECUTE_READ
	case x:
		return windows.PAGE_EXECUTE
	case w:
		return windows.PAGE_READWRITE
	case r:
		return windows.PAGE_READONLY
	default:
		return windows.PAGE_NOACCESS
	}
}

var (
	modKernel32     = windows.NewLazySystemDLL("kernel32.dll")
	procGetProcAddr = modKernel32.NewProc("GetProcAddress")
)

func getProcByOrdinal(module windows.Handle, ordinal uint16) (uintptr, error) {
	r, _, err := procGetProcAddr.Call(uintptr(module), uintptr(ordinal))
	if r == 0 {
		return 0, fmt.Errorf("pe: GetProcAddress ordinal %d: %w", ordinal, err)
	}
	return r, nil
}
