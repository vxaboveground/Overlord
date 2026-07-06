package capture

import (
	"image"
	"sync/atomic"
)

const (
	maxPooledRGBABuffers = 8
	maxPooledRGBABytes   = 64 << 20
	maxTotalRGBABytes    = 192 << 20
)

var (
	rgbaPool        = make(chan []byte, maxPooledRGBABuffers)
	pooledRGBABytes atomic.Int64
)

func GetRGBA(w, h int) *image.RGBA {
	need := w * h * 4
	if need <= 0 {
		return image.NewRGBA(image.Rect(0, 0, w, h))
	}
	for attempts := len(rgbaPool); attempts > 0; attempts-- {
		select {
		case buf := <-rgbaPool:
			pooledRGBABytes.Add(-int64(cap(buf)))
			if cap(buf) >= need && cap(buf) <= maxReusableCapacity(need) {
				return &image.RGBA{
					Pix:    buf[:need],
					Stride: w * 4,
					Rect:   image.Rect(0, 0, w, h),
				}
			}
		default:
			attempts = 0
		}
	}
	return image.NewRGBA(image.Rect(0, 0, w, h))
}

func PutRGBA(img *image.RGBA) {
	if img == nil || len(img.Pix) == 0 {
		return
	}
	buf := img.Pix
	capacity := cap(buf)
	if capacity <= 0 || capacity > maxPooledRGBABytes {
		return
	}
	for {
		cur := pooledRGBABytes.Load()
		if cur+int64(capacity) > maxTotalRGBABytes {
			return
		}
		if pooledRGBABytes.CompareAndSwap(cur, cur+int64(capacity)) {
			break
		}
	}
	select {
	case rgbaPool <- buf:
	default:
		pooledRGBABytes.Add(-int64(capacity))
	}
}

func maxReusableCapacity(need int) int {
	limit := need * 2
	if limit < need+(1<<20) {
		limit = need + (1 << 20)
	}
	if limit > maxPooledRGBABytes {
		limit = maxPooledRGBABytes
	}
	return limit
}
