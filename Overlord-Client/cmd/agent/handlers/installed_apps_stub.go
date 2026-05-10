//go:build !windows

package handlers

type appWithIcon struct {
	Name    string
	ExePath string
	Icon    string
}

type installedApp struct {
	name    string
	exePath string
}

func getInstalledAppsWithIcons() []appWithIcon {
	return nil
}

func enumerateInstalledApps() []installedApp {
	return nil
}

func extractIconBase64(_ string) string {
	return ""
}
