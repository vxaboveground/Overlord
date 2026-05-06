package mutex

import (
	"fmt"
	"strings"
	"sync"
)

const maxMutexLength = 64

var (
	globalRelease func()
	globalMu      sync.Mutex
)

func SetGlobalRelease(fn func()) {
	globalMu.Lock()
	globalRelease = fn
	globalMu.Unlock()
}

func ReleaseGlobal() {
	globalMu.Lock()
	fn := globalRelease
	globalRelease = nil
	globalMu.Unlock()
	if fn != nil {
		fn()
	}
}

func sanitizeName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", fmt.Errorf("empty mutex name")
	}

	var builder strings.Builder
	for _, r := range trimmed {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			builder.WriteRune(r)
		}
	}

	sanitized := builder.String()
	if sanitized == "" {
		return "", fmt.Errorf("mutex name has no valid characters")
	}

	if len(sanitized) > maxMutexLength {
		sanitized = sanitized[:maxMutexLength]
	}

	return sanitized, nil
}
