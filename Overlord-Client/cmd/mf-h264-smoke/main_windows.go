//go:build windows

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"overlord-client/cmd/agent/capture"
	"overlord-client/cmd/agent/sysinfo"
)

type machineInfo struct {
	Hostname    string `json:"hostname"`
	OS          string `json:"os"`
	Arch        string `json:"arch"`
	CPU         string `json:"cpu"`
	GPU         string `json:"gpu"`
	RAM         string `json:"ram"`
	GeneratedAt string `json:"generated_at"`
}

type smokeReport struct {
	Machine      machineInfo                     `json:"machine"`
	Findings     []capture.H264MFTFinding        `json:"media_foundation_findings"`
	FindingError string                          `json:"media_foundation_finding_error,omitempty"`
	H264         []capture.H264SmokeResult       `json:"h264"`
	Capture      []capture.CaptureSmokeResult    `json:"capture,omitempty"`
	NVENC        *capture.NVENCSmokeResult       `json:"nvenc,omitempty"`
	NVENCD3D11   []capture.NVENCD3D11SmokeResult `json:"nvenc_d3d11,omitempty"`
	Nvidia       []string                        `json:"nvidia_smi,omitempty"`
}

func main() {
	var frames int
	var captureFrames int
	var captureDisplay int
	var captureFPS int
	var captureMaxHeight int
	var jsonOut bool
	var includeCapture bool
	var includeNVENC bool
	var includeNVENCD3D11 bool
	var resArg string
	var fpsArg string
	var providersArg string
	var reportPath string
	flag.IntVar(&frames, "frames", 30, "frames to feed each encoder case")
	flag.IntVar(&captureFrames, "capture-frames", 30, "frames to capture for each capture backend")
	flag.IntVar(&captureDisplay, "display", 0, "display index for capture smoke")
	flag.IntVar(&captureFPS, "capture-fps", 0, "target FPS for direct H.264 capture smoke")
	flag.IntVar(&captureMaxHeight, "capture-max-height", 0, "max capture output height; use -1 to bypass the resolution cap")
	flag.BoolVar(&jsonOut, "json", false, "print JSON instead of a table")
	flag.BoolVar(&includeCapture, "capture", false, "also time DXGI-preferred and BitBlt capture backends")
	flag.BoolVar(&includeNVENC, "nvenc", false, "also probe the native NVIDIA NVENC API and nvidia-smi")
	flag.BoolVar(&includeNVENCD3D11, "nvenc-d3d11", false, "also encode test frames through NVENC using a D3D11 NV12 texture")
	flag.StringVar(&resArg, "res", "1280x720,1920x1080,2560x1440,3840x2160", "comma-separated resolutions")
	flag.StringVar(&fpsArg, "fps", "30,60,120", "comma-separated requested FPS values")
	flag.StringVar(&providersArg, "providers", "hardware,software", "comma-separated providers: hardware,software")
	flag.StringVar(&reportPath, "report", "", "also write the complete JSON report to this file")
	flag.Parse()
	hostname, _ := os.Hostname()
	system := sysinfo.Collect()
	machine := machineInfo{Hostname: hostname, OS: sysinfo.OSName(), Arch: runtime.GOARCH, CPU: system.CPU, GPU: system.GPU, RAM: system.RAM, GeneratedAt: time.Now().Format(time.RFC3339)}
	findings, findingErr := capture.FindH264HardwareMFTs()

	opts := capture.DefaultH264SmokeOptions()
	opts.Frames = frames
	opts.Resolutions = parseResolutions(resArg)
	opts.FPS = parseInts(fpsArg)
	opts.Providers = parseStrings(providersArg)

	results := capture.RunH264Smoke(opts)
	var captureResults []capture.CaptureSmokeResult
	if includeCapture {
		captureResults = capture.RunCaptureSmoke(capture.CaptureSmokeOptions{Display: captureDisplay, Frames: captureFrames, FPS: captureFPS, MaxHeight: captureMaxHeight})
	}
	var nvencResult *capture.NVENCSmokeResult
	var nvidiaSMI []string
	if includeNVENC {
		result := capture.RunNVENCSmoke()
		nvencResult = &result
		nvidiaSMI = queryNvidiaSMI()
	}
	var nvencD3D11Results []capture.NVENCD3D11SmokeResult
	if includeNVENCD3D11 {
		nvencD3D11Results = runNVENCD3D11SmokeCases(opts.Resolutions, opts.FPS, frames)
		if !includeNVENC {
			nvidiaSMI = queryNvidiaSMI()
		}
	}
	report := smokeReport{Machine: machine, Findings: findings, H264: results, Capture: captureResults, NVENC: nvencResult, NVENCD3D11: nvencD3D11Results, Nvidia: nvidiaSMI}
	if findingErr != nil {
		report.FindingError = findingErr.Error()
	}
	if reportPath != "" {
		if err := writeJSONReport(reportPath, report); err != nil {
			fmt.Fprintf(os.Stderr, "write report failed: %v\n", err)
			os.Exit(1)
		}
	}
	if jsonOut {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(report); err != nil {
			fmt.Fprintf(os.Stderr, "json encode failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	printMachine(machine)
	printMFTFindings(findings, findingErr)
	fmt.Println()
	printTable(results)
	if includeCapture {
		fmt.Println()
		printCaptureTable(captureResults)
	}
	if includeNVENC {
		fmt.Println()
		printNVENCSummary(nvencResult, nvidiaSMI)
	}
	if includeNVENCD3D11 {
		fmt.Println()
		printNVENCD3D11Table(nvencD3D11Results)
		if !includeNVENC {
			for _, line := range nvidiaSMI {
				fmt.Println("nvidia-smi:", line)
			}
		}
	}
}

func writeJSONReport(path string, report smokeReport) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	return enc.Encode(report)
}

func printMachine(info machineInfo) {
	fmt.Println("Machine:")
	fmt.Printf("  Host: %s\n  OS:   %s (%s)\n  CPU:  %s\n  GPU:  %s\n  RAM:  %s\n  Time: %s\n", info.Hostname, info.OS, info.Arch, info.CPU, info.GPU, info.RAM, info.GeneratedAt)
}

func printMFTFindings(findings []capture.H264MFTFinding, err error) {
	fmt.Println("Media Foundation hardware H.264 findings:")
	if err != nil {
		fmt.Printf("  ERROR: %v\n", err)
		return
	}
	if len(findings) == 0 {
		fmt.Println("  No hardware H.264 MFTs found.")
		return
	}
	for _, finding := range findings {
		status := "ok"
		if !finding.ActivationOK {
			status = "failed"
		}
		mode := "sync"
		if finding.Asynchronous {
			mode = "async"
		}
		fmt.Printf("  [%d] %s | activation=%s | mode=%s | d3d11=%t\n", finding.Index, finding.Name, status, mode, finding.D3D11Aware)
		if finding.HardwareURL != "" {
			fmt.Printf("      device: %s\n", finding.HardwareURL)
		}
		if finding.Error != "" {
			fmt.Printf("      error: %s\n", finding.Error)
		}
	}
}

func parseResolutions(raw string) []capture.H264SmokeResolution {
	parts := parseStrings(raw)
	out := make([]capture.H264SmokeResolution, 0, len(parts))
	for _, part := range parts {
		fields := strings.Split(strings.ToLower(part), "x")
		if len(fields) != 2 {
			continue
		}
		w, werr := strconv.Atoi(strings.TrimSpace(fields[0]))
		h, herr := strconv.Atoi(strings.TrimSpace(fields[1]))
		if werr == nil && herr == nil {
			out = append(out, capture.H264SmokeResolution{Width: w, Height: h})
		}
	}
	return out
}

func parseInts(raw string) []int {
	parts := parseStrings(raw)
	out := make([]int, 0, len(parts))
	for _, part := range parts {
		if v, err := strconv.Atoi(part); err == nil {
			out = append(out, v)
		}
	}
	return out
}

func parseStrings(raw string) []string {
	fields := strings.Split(raw, ",")
	out := make([]string, 0, len(fields))
	for _, field := range fields {
		field = strings.TrimSpace(field)
		if field != "" {
			out = append(out, field)
		}
	}
	return out
}

func printTable(results []capture.H264SmokeResult) {
	fmt.Printf("%-28s %-5s %-5s %9s %7s %7s %8s %9s %8s %7s %9s %9s %s\n",
		"provider", "mode", "input", "size", "reqfps", "cfgfps", "config", "first_ms", "avg_ms", "frames", "avg_bytes", "total", "error")
	for _, r := range results {
		status := "fail"
		if r.ConfigureOK && r.EncodeOK {
			status = "ok"
		} else if r.ConfigureOK {
			status = "no-data"
		}
		mode := "sync"
		if r.Asynchronous {
			mode = "async"
		}
		fmt.Printf("%-28s %-5s %-5s %4dx%-4d %7d %7d %8s %9.2f %8.2f %7d %9.0f %9d %s\n",
			r.Provider, mode, r.Input, r.Width, r.Height, r.RequestedFPS, r.ConfiguredFPS, status,
			r.FirstOutputMS, r.AvgEncodeMS, r.FramesTried, r.AvgBytes, r.TotalBytes, r.Error)
	}
}

func printCaptureTable(results []capture.CaptureSmokeResult) {
	fmt.Printf("%-18s %-6s %7s %7s %7s %9s %9s %9s %9s %9s %9s %9s %s\n", "backend", "format", "display", "ok", "attempt", "size", "avg_ms", "cap_ms", "enc_ms", "first_enc", "steady", "avg_bytes", "error")
	for _, r := range results {
		fmt.Printf("%-18s %-6s %7d %7d %7d %4dx%-4d %9.2f %9.2f %9.2f %9.2f %9.2f %9.0f %s\n",
			r.Backend, r.Format, r.Display, r.OK, r.Attempts, r.Width, r.Height, r.AvgMS, r.AvgCapMS, r.AvgEncMS, r.FirstEncMS, r.SteadyEncMS, r.AvgBytes, r.Error)
	}
}

func printNVENCSummary(result *capture.NVENCSmokeResult, smi []string) {
	if result == nil {
		return
	}
	status := "unavailable"
	if result.Available {
		status = fmt.Sprintf("available api=%d.%d raw=%d", result.APIMajor, result.APIMinor, result.RawAPI)
	}
	fmt.Printf("nvenc: %s dll=%s", status, result.DLL)
	if result.Error != "" {
		fmt.Printf(" error=%s", result.Error)
	}
	fmt.Println()
	for _, line := range smi {
		fmt.Println("nvidia-smi:", line)
	}
}

func runNVENCD3D11SmokeCases(resolutions []capture.H264SmokeResolution, fpsValues []int, frames int) []capture.NVENCD3D11SmokeResult {
	out := make([]capture.NVENCD3D11SmokeResult, 0, len(resolutions)*len(fpsValues))
	for _, res := range resolutions {
		for _, fps := range fpsValues {
			out = append(out, capture.RunNVENCD3D11Smoke(capture.NVENCD3D11SmokeOptions{
				Width:  res.Width,
				Height: res.Height,
				FPS:    fps,
				Frames: frames,
			}))
		}
	}
	return out
}

func printNVENCD3D11Table(results []capture.NVENCD3D11SmokeResult) {
	fmt.Printf("%-12s %9s %7s %7s %9s %8s %9s %9s %s\n",
		"nvenc-d3d11", "size", "fps", "frames", "first_ms", "avg_ms", "avg_bytes", "total", "error")
	for _, r := range results {
		status := "fail"
		if r.OK {
			status = "ok"
		}
		avgBytes := float64(0)
		if r.Frames > 0 {
			avgBytes = float64(r.TotalBytes) / float64(r.Frames)
		}
		fmt.Printf("%-12s %4dx%-4d %7d %7d %9.2f %8.2f %9.0f %9d %s\n",
			status, r.Width, r.Height, r.FPS, r.Frames, r.FirstMS, r.AvgMS, avgBytes, r.TotalBytes, r.Error)
	}
}

func queryNvidiaSMI() []string {
	cmd := exec.Command("nvidia-smi", "--query-gpu=name,driver_version,encoder.stats.sessionCount,encoder.stats.averageFps,encoder.stats.averageLatency", "--format=csv,noheader")
	out, err := cmd.Output()
	if err != nil {
		return []string{err.Error()}
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	result := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			result = append(result, line)
		}
	}
	return result
}
