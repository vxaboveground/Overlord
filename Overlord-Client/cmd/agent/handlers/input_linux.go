//go:build linux

package handlers

// Linux input is not implemented — all input functions are no-ops.

func setCursorPos(x, y int32)        {}
func sendMouseDown(button int)       {}
func sendMouseUp(button int)         {}
func sendKeyDown(vk uint16)          {}
func sendKeyUp(vk uint16)            {}
func sendTextInput(text string)      {}
func keyCodeToVK(code string) uint16 { return 0 }
