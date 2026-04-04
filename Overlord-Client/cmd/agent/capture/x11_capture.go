//go:build linux

package capture

import (
	"fmt"
	"image"
	"log"
	"sync"

	"github.com/gen2brain/shm"
	"github.com/jezek/xgb"
	xshm "github.com/jezek/xgb/shm"
	"github.com/jezek/xgb/xinerama"
	"github.com/jezek/xgb/xproto"
)

type x11State struct {
	mu sync.Mutex

	conn   *xgb.Conn
	screen *xproto.ScreenInfo
	root   xproto.Window

	screens []xinerama.ScreenInfo
	primary xinerama.ScreenInfo

	shmSeg   xshm.Seg
	shmId    int
	shmData  []byte
	shmW     int
	shmH     int
	shmReady bool
	useShm   bool

	imgCache map[int]*image.RGBA
}

var x11 x11State

func x11Init() error {
	x11.mu.Lock()
	defer x11.mu.Unlock()
	return x11InitLocked()
}

func x11InitLocked() error {
	if x11.conn != nil {
		return nil
	}

	c, err := xgb.NewConn()
	if err != nil {
		return fmt.Errorf("x11 capture: connect: %w", err)
	}

	if err := xinerama.Init(c); err != nil {
		c.Close()
		return fmt.Errorf("x11 capture: xinerama init: %w", err)
	}

	reply, err := xinerama.QueryScreens(c).Reply()
	if err != nil || reply.Number == 0 {
		c.Close()
		if err != nil {
			return fmt.Errorf("x11 capture: query screens: %w", err)
		}
		return fmt.Errorf("x11 capture: no screens found")
	}

	x11.conn = c
	x11.screen = xproto.Setup(c).DefaultScreen(c)
	x11.root = x11.screen.Root
	x11.screens = reply.ScreenInfo
	x11.primary = reply.ScreenInfo[0]
	x11.imgCache = make(map[int]*image.RGBA)

	x11.useShm = true
	if err := xshm.Init(c); err != nil {
		log.Printf("x11 capture: shm extension not available, will use GetImage (slower)")
		x11.useShm = false
	}

	log.Printf("x11 capture: connected, %d screens, shm=%v, screen=%dx%d",
		len(x11.screens), x11.useShm,
		x11.screen.WidthInPixels, x11.screen.HeightInPixels)
	return nil
}

func x11ResetLocked() {
	if x11.shmReady {
		if x11.conn != nil {
			xshm.Detach(x11.conn, x11.shmSeg)
		}
		_ = shm.Dt(x11.shmData)
		_ = shm.Rm(x11.shmId)
		x11.shmReady = false
		x11.shmData = nil
		x11.shmW = 0
		x11.shmH = 0
	}
	if x11.conn != nil {
		x11.conn.Close()
		x11.conn = nil
	}
	x11.screens = nil
	x11.imgCache = nil
}

func x11Reset() {
	x11.mu.Lock()
	defer x11.mu.Unlock()
	x11ResetLocked()
}

func x11EnsureShm(w, h int) error {
	if x11.shmReady && x11.shmW == w && x11.shmH == h {
		return nil
	}

	if x11.shmReady {
		xshm.Detach(x11.conn, x11.shmSeg)
		_ = shm.Dt(x11.shmData)
		_ = shm.Rm(x11.shmId)
		x11.shmReady = false
	}

	size := w * h * 4
	shmId, err := shm.Get(shm.IPC_PRIVATE, size, shm.IPC_CREAT|0o777)
	if err != nil {
		return fmt.Errorf("shm.Get(%d): %w", size, err)
	}

	seg, err := xshm.NewSegId(x11.conn)
	if err != nil {
		_ = shm.Rm(shmId)
		return fmt.Errorf("shm.NewSegId: %w", err)
	}

	data, err := shm.At(shmId, 0, 0)
	if err != nil {
		_ = shm.Rm(shmId)
		return fmt.Errorf("shm.At: %w", err)
	}

	xshm.Attach(x11.conn, seg, uint32(shmId), false)

	x11.shmSeg = seg
	x11.shmId = shmId
	x11.shmData = data
	x11.shmW = w
	x11.shmH = h
	x11.shmReady = true
	return nil
}

func x11DisplayCount() int {
	x11.mu.Lock()
	defer x11.mu.Unlock()

	if x11.conn == nil {
		if err := x11InitLocked(); err != nil {
			return 0
		}
	}
	return len(x11.screens)
}

func x11DisplayBounds(idx int) image.Rectangle {
	x11.mu.Lock()
	defer x11.mu.Unlock()

	if x11.conn == nil {
		if err := x11InitLocked(); err != nil {
			return image.Rectangle{}
		}
	}
	if idx < 0 || idx >= len(x11.screens) {
		return image.Rectangle{}
	}

	x0 := int(x11.primary.XOrg)
	y0 := int(x11.primary.YOrg)
	s := x11.screens[idx]
	x := int(s.XOrg) - x0
	y := int(s.YOrg) - y0
	w := int(s.Width)
	h := int(s.Height)
	return image.Rect(x, y, x+w, y+h)
}

func x11CaptureDisplay(display int) (*image.RGBA, error) {
	x11.mu.Lock()
	defer x11.mu.Unlock()

	if x11.conn == nil {
		if err := x11InitLocked(); err != nil {
			return nil, err
		}
	}

	if display < 0 || display >= len(x11.screens) {
		return nil, fmt.Errorf("x11 capture: display %d out of range (0-%d)", display, len(x11.screens)-1)
	}

	s := x11.screens[display]
	x := int(s.XOrg)
	y := int(s.YOrg)
	w := int(s.Width)
	h := int(s.Height)

	rootW := int(x11.screen.WidthInPixels)
	rootH := int(x11.screen.HeightInPixels)
	if x+w > rootW {
		w = rootW - x
	}
	if y+h > rootH {
		h = rootH - y
	}
	if w <= 0 || h <= 0 {
		return nil, fmt.Errorf("x11 capture: zero-size region for display %d", display)
	}

	var data []byte

	if x11.useShm {
		if err := x11EnsureShm(w, h); err != nil {
			log.Printf("x11 capture: shm alloc failed, falling back to GetImage: %v", err)
			x11.useShm = false
		} else {
			_, err := xshm.GetImage(x11.conn, xproto.Drawable(x11.root),
				int16(x), int16(y), uint16(w), uint16(h),
				0xffffffff, byte(xproto.ImageFormatZPixmap),
				x11.shmSeg, 0).Reply()
			if err != nil {
				log.Printf("x11 capture: shm GetImage failed: %v (resetting)", err)
				x11ResetLocked()
				return nil, fmt.Errorf("x11 capture: shm GetImage: %w", err)
			}
			data = x11.shmData[:w*h*4]
		}
	}

	if data == nil {
		xImg, err := xproto.GetImage(x11.conn, xproto.ImageFormatZPixmap,
			xproto.Drawable(x11.root),
			int16(x), int16(y), uint16(w), uint16(h),
			0xffffffff).Reply()
		if err != nil {
			log.Printf("x11 capture: GetImage failed: %v (resetting)", err)
			x11ResetLocked()
			return nil, fmt.Errorf("x11 capture: GetImage: %w", err)
		}
		data = xImg.Data
	}

	img := x11.imgCache[display]
	if img == nil || img.Rect.Dx() != w || img.Rect.Dy() != h {
		img = image.NewRGBA(image.Rect(0, 0, w, h))
		x11.imgCache[display] = img
	}

	pixels := img.Pix
	stride := img.Stride
	srcOff := 0
	for iy := 0; iy < h; iy++ {
		dstRow := iy * stride
		for ix := 0; ix < w; ix++ {
			dstOff := dstRow + ix*4
			pixels[dstOff+0] = data[srcOff+2] // R
			pixels[dstOff+1] = data[srcOff+1] // G
			pixels[dstOff+2] = data[srcOff+0] // B
			pixels[dstOff+3] = 255            // A
			srcOff += 4
		}
	}

	return img, nil
}
