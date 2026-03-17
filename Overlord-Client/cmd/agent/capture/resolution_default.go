//go:build !windows

package capture

func SetMaxResolution(maxH int) {}

func BypassResolutionCap() (restore func()) {
	return func() {}
}

func EffectiveScaleForInput() float64 {
	return 1.0
}
