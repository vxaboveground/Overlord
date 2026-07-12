//go:build !windows

package handlers

func keyCodeToVKVirtual(code string) uint16 {
	return 0
}
