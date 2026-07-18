//go:build !windows

package capture

func ProbeDesktopEncoderCapabilities(display int) DesktopEncoderCapabilities {
	return completeDesktopEncoderCapabilities(DesktopEncoderCapabilities{
		Display: display,
		Profiles: []DesktopEncoderProfile{
			{MaxHeight: 720, Width: 1280, Height: 720, FPS: 60, Label: "60 FPS - 720p", Providers: []string{"Software H.264 / JPEG"}},
			{MaxHeight: 1080, Width: 1920, Height: 1080, FPS: 60, Label: "60 FPS - 1080p", Providers: []string{"Software H.264 / JPEG"}},
		},
		Detail: "Hardware H.264 capability probing is available on Windows; safe software profiles are shown.",
	})
}
