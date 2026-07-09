package handlers

import "encoding/json"

func extractTimestamp(v interface{}) int64 {
	ts, ok := extractTimestampIfPresent(v)
	if !ok {
		return 0
	}
	return ts
}

func extractTimestampIfPresent(v interface{}) (int64, bool) {
	switch t := v.(type) {
	case uint64:
		if t <= uint64(^uint64(0)>>1) {
			return int64(t), true
		}
		return 0, false
	case uint32:
		return int64(t), true
	case uint16:
		return int64(t), true
	case uint8:
		return int64(t), true
	case int64:
		return t, true
	case int32:
		return int64(t), true
	case int16:
		return int64(t), true
	case int8:
		return int64(t), true
	case int:
		return int64(t), true
	case float64:
		return int64(t), true
	case float32:
		return int64(t), true
	case json.Number:
		if n, err := t.Int64(); err == nil {
			return n, true
		}
	}
	return 0, false
}
