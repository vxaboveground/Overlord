//go:build windows

package handlers

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"log"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	iaShell32            = windows.NewLazySystemDLL("shell32.dll")
	iaUser32             = windows.NewLazySystemDLL("user32.dll")
	iaGdi32              = windows.NewLazySystemDLL("gdi32.dll")
	pExtractIconExW      = iaShell32.NewProc("ExtractIconExW")
	pDestroyIcon         = iaUser32.NewProc("DestroyIcon")
	pGetIconInfo         = iaUser32.NewProc("GetIconInfo")
	pGetDIBits           = iaGdi32.NewProc("GetDIBits")
	pCreateCompatibleDC  = iaGdi32.NewProc("CreateCompatibleDC")
	pDeleteDC            = iaGdi32.NewProc("DeleteDC")
	pDeleteObject        = iaGdi32.NewProc("DeleteObject")
	pGetObjectW          = iaGdi32.NewProc("GetObjectW")
)

type iconInfo struct {
	FIcon    int32
	XHotspot uint32
	YHotspot uint32
	HbmMask  windows.Handle
	HbmColor windows.Handle
}

type bitmapInfoHeader struct {
	BiSize          uint32
	BiWidth         int32
	BiHeight        int32
	BiPlanes        uint16
	BiBitCount      uint16
	BiCompression   uint32
	BiSizeImage     uint32
	BiXPelsPerMeter int32
	BiYPelsPerMeter int32
	BiClrUsed       uint32
	BiClrImportant  uint32
}

type bitmapObj struct {
	BmType       int32
	BmWidth      int32
	BmHeight     int32
	BmWidthBytes int32
	BmPlanes     uint16
	BmBitsPixel  uint16
	BmBits       uintptr
}

type installedApp struct {
	name    string
	exePath string
}

func enumerateInstalledApps() []installedApp {
	seen := make(map[string]bool)
	var apps []installedApp

	add := func(name, exePath string) {
		if name == "" || exePath == "" {
			return
		}
		exePath = normalizeExePath(exePath)
		if exePath == "" {
			return
		}
		lower := strings.ToLower(exePath)
		if seen[lower] {
			return
		}
		if !strings.HasSuffix(lower, ".exe") {
			return
		}
		if _, err := os.Stat(exePath); err != nil {
			return
		}
		if isUninstallExe(lower) {
			return
		}
		seen[lower] = true
		apps = append(apps, installedApp{name: name, exePath: exePath})
	}

	uninstallPaths := []struct {
		root registry.Key
		path string
	}{
		{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`},
		{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`},
		{registry.CURRENT_USER, `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`},
	}
	for _, up := range uninstallPaths {
		enumerateUninstallKey(up.root, up.path, add)
	}

	appPathRoots := []struct {
		root registry.Key
		path string
	}{
		{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths`},
		{registry.CURRENT_USER, `SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths`},
	}
	for _, ap := range appPathRoots {
		enumerateAppPaths(ap.root, ap.path, add)
	}

	enumerateStartMenu(add)

	return apps
}

func enumerateUninstallKey(root registry.Key, path string, add func(string, string)) {
	k, err := registry.OpenKey(root, path, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return
	}
	defer k.Close()

	subkeys, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return
	}

	for _, sub := range subkeys {
		sk, err := registry.OpenKey(root, path+`\`+sub, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		name, _, _ := sk.GetStringValue("DisplayName")
		if name == "" {
			sk.Close()
			continue
		}

		var exePath string
		icon, _, err := sk.GetStringValue("DisplayIcon")
		if err == nil && icon != "" {
			exePath = normalizeExePath(icon)
		}
		if exePath == "" {
			loc, _, err := sk.GetStringValue("InstallLocation")
			if err == nil && loc != "" {
				exePath = findExeInDir(loc)
			}
		}
		sk.Close()
		add(name, exePath)
	}
}

func enumerateAppPaths(root registry.Key, path string, add func(string, string)) {
	k, err := registry.OpenKey(root, path, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return
	}
	defer k.Close()

	subkeys, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return
	}

	for _, sub := range subkeys {
		sk, err := registry.OpenKey(root, path+`\`+sub, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		val, _, err := sk.GetStringValue("")
		sk.Close()
		if err != nil || val == "" {
			continue
		}
		name := strings.TrimSuffix(sub, filepath.Ext(sub))
		add(name, val)
	}
}

func enumerateStartMenu(add func(string, string)) {
	dirs := []string{
		os.Getenv("ProgramData") + `\Microsoft\Windows\Start Menu\Programs`,
		os.Getenv("APPDATA") + `\Microsoft\Windows\Start Menu\Programs`,
	}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			if !strings.HasSuffix(strings.ToLower(path), ".lnk") {
				return nil
			}
			target := resolveShortcut(path)
			if target == "" || !strings.HasSuffix(strings.ToLower(target), ".exe") {
				return nil
			}
			name := strings.TrimSuffix(info.Name(), ".lnk")
			if strings.HasPrefix(strings.ToLower(name), "uninstall") {
				return nil
			}
			add(name, target)
			return nil
		})
	}
}

func resolveShortcut(lnkPath string) string {
	data, err := os.ReadFile(lnkPath)
	if err != nil || len(data) < 78 {
		return ""
	}
	// Verify magic: 4C 00 00 00
	if data[0] != 0x4C || data[1] != 0x00 || data[2] != 0x00 || data[3] != 0x00 {
		return ""
	}
	flags := uint32(data[0x14]) | uint32(data[0x15])<<8 | uint32(data[0x16])<<16 | uint32(data[0x17])<<24
	hasLinkTargetIDList := flags&0x01 != 0
	hasLinkInfo := flags&0x02 != 0

	offset := 0x4C // header size

	if hasLinkTargetIDList {
		if offset+2 > len(data) {
			return ""
		}
		idListSize := int(uint16(data[offset]) | uint16(data[offset+1])<<8)
		offset += 2 + idListSize
	}

	if !hasLinkInfo {
		return ""
	}
	if offset+4 > len(data) {
		return ""
	}

	linkInfoSize := int(uint32(data[offset]) | uint32(data[offset+1])<<8 | uint32(data[offset+2])<<16 | uint32(data[offset+3])<<24)
	if linkInfoSize < 28 || offset+linkInfoSize > len(data) {
		return ""
	}

	linkInfoData := data[offset : offset+linkInfoSize]

	localBasePathOffset := int(uint32(linkInfoData[0x10]) | uint32(linkInfoData[0x11])<<8 | uint32(linkInfoData[0x12])<<16 | uint32(linkInfoData[0x13])<<24)

	if localBasePathOffset == 0 || localBasePathOffset >= len(linkInfoData) {
		return ""
	}

	end := localBasePathOffset
	for end < len(linkInfoData) && linkInfoData[end] != 0 {
		end++
	}
	return string(linkInfoData[localBasePathOffset:end])
}

func normalizeExePath(p string) string {
	if p == "" {
		return ""
	}
	p = strings.TrimSpace(p)
	p = strings.Trim(p, `"`)
	// Strip icon index suffix: path.exe,0
	if idx := strings.LastIndex(p, ","); idx > 0 {
		candidate := strings.TrimSpace(p[:idx])
		if strings.HasSuffix(strings.ToLower(candidate), ".exe") {
			p = candidate
		}
	}
	p = os.ExpandEnv(p)
	return p
}

func findExeInDir(dir string) string {
	if dir == "" {
		return ""
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var bestPath string
	var bestSize int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if !strings.HasSuffix(strings.ToLower(e.Name()), ".exe") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.Size() > bestSize {
			bestSize = info.Size()
			bestPath = filepath.Join(dir, e.Name())
		}
	}
	return bestPath
}

func isUninstallExe(lowerPath string) bool {
	base := strings.ToLower(filepath.Base(lowerPath))
	return strings.Contains(base, "unins") ||
		strings.Contains(base, "uninst") ||
		strings.Contains(base, "uninstall") ||
		strings.HasPrefix(base, "remove")
}

func extractIconBase64(exePath string) string {
	pathPtr, err := windows.UTF16PtrFromString(exePath)
	if err != nil {
		return ""
	}

	var hIconLarge uintptr
	ret, _, _ := pExtractIconExW.Call(
		uintptr(unsafe.Pointer(pathPtr)),
		0,
		uintptr(unsafe.Pointer(&hIconLarge)),
		0,
		1,
	)
	if ret == 0 || hIconLarge == 0 {
		return ""
	}
	defer pDestroyIcon.Call(hIconLarge)

	var ii iconInfo
	r, _, _ := pGetIconInfo.Call(hIconLarge, uintptr(unsafe.Pointer(&ii)))
	if r == 0 {
		return ""
	}
	if ii.HbmMask != 0 {
		defer pDeleteObject.Call(uintptr(ii.HbmMask))
	}
	if ii.HbmColor == 0 {
		return ""
	}
	defer pDeleteObject.Call(uintptr(ii.HbmColor))

	var bm bitmapObj
	pGetObjectW.Call(uintptr(ii.HbmColor), unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm)))
	if bm.BmWidth <= 0 || bm.BmHeight <= 0 {
		return ""
	}

	w := int(bm.BmWidth)
	h := int(bm.BmHeight)

	hdc, _, _ := pCreateCompatibleDC.Call(0)
	if hdc == 0 {
		return ""
	}
	defer pDeleteDC.Call(hdc)

	bih := bitmapInfoHeader{
		BiSize:     uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		BiWidth:    int32(w),
		BiHeight:   -int32(h), // top-down
		BiPlanes:   1,
		BiBitCount: 32,
	}

	pixels := make([]byte, w*h*4)
	pGetDIBits.Call(hdc, uintptr(ii.HbmColor), 0, uintptr(h),
		uintptr(unsafe.Pointer(&pixels[0])),
		uintptr(unsafe.Pointer(&bih)),
		0, // DIB_RGB_COLORS
	)

	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			off := (y*w + x) * 4
			// BGRA → RGBA
			img.SetRGBA(x, y, color.RGBA{
				R: pixels[off+2],
				G: pixels[off+1],
				B: pixels[off+0],
				A: pixels[off+3],
			})
		}
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

type appWithIcon struct {
	Name    string
	ExePath string
	Icon    string
}

func getInstalledAppsWithIcons() []appWithIcon {
	apps := enumerateInstalledApps()
	log.Printf("hvnc: enumerated %d installed apps, extracting icons", len(apps))

	out := make([]appWithIcon, len(apps))
	for i, app := range apps {
		out[i] = appWithIcon{
			Name:    app.name,
			ExePath: app.exePath,
			Icon:    extractIconBase64(app.exePath),
		}
	}
	return out
}
