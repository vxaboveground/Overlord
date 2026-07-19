package capture

import (
	"context"
	"image"
	"sync"

	rt "overlord-client/cmd/agent/runtime"
	"overlord-client/cmd/agent/wire"
)

type DesktopCursorMetadata struct {
	X            int
	Y            int
	Visible      bool
	Enabled      bool
	Shape        uint64
	Generation   uint64
	CursorWidth  int
	CursorHeight int
	HotspotX     int
	HotspotY     int
	Image        []byte
}

type desktopCursorStreamState struct {
	x          int
	y          int
	width      int
	height     int
	visible    bool
	enabled    bool
	shape      uint64
	generation uint64
}

var desktopCursorStream struct {
	sync.Mutex
	last desktopCursorStreamState
}

func emitDesktopCursor(ctx context.Context, env *rt.Env, display, frameWidth, frameHeight int) {
	desktopCursorStream.Lock()
	previousSize := desktopCursorStream.last
	desktopCursorStream.Unlock()
	frameWidth, frameHeight = resolveCursorFrameSize(
		frameWidth,
		frameHeight,
		previousSize,
		DisplayBounds(display),
	)
	cursor := DesktopCursorState(display, frameWidth, frameHeight)

	desktopCursorStream.Lock()
	previous := desktopCursorStream.last
	positionChanged := cursor.X != previous.x || cursor.Y != previous.y ||
		frameWidth != previous.width || frameHeight != previous.height ||
		cursor.Visible != previous.visible || cursor.Enabled != previous.enabled
	shapeChanged := cursorShapeNeedsRefresh(cursor, previous, frameWidth, frameHeight)
	includeShape := shapeChanged && len(cursor.Image) != 0
	if !positionChanged && !includeShape {
		desktopCursorStream.Unlock()
		return
	}
	next := previous
	next.x, next.y = cursor.X, cursor.Y
	next.width, next.height = frameWidth, frameHeight
	next.visible, next.enabled = cursor.Visible, cursor.Enabled
	if includeShape {
		next.shape, next.generation = cursor.Shape, cursor.Generation
	}
	desktopCursorStream.last = next
	desktopCursorStream.Unlock()

	if !cursor.Enabled && !previous.enabled {
		return
	}
	message := wire.DesktopCursor{
		Type:    "desktop_cursor",
		X:       cursor.X,
		Y:       cursor.Y,
		Width:   frameWidth,
		Height:  frameHeight,
		Visible: cursor.Enabled && cursor.Visible,
	}
	if includeShape {
		message.CursorWidth = cursor.CursorWidth
		message.CursorHeight = cursor.CursorHeight
		message.HotspotX = cursor.HotspotX
		message.HotspotY = cursor.HotspotY
		message.Image = cursor.Image
	}
	_ = wire.WriteMsg(ctx, env.Conn, message)
}

func cursorShapeNeedsRefresh(cursor DesktopCursorMetadata, previous desktopCursorStreamState, frameWidth, frameHeight int) bool {
	return cursor.Enabled &&
		(cursor.Shape != previous.shape || cursor.Generation != previous.generation ||
			frameWidth != previous.width || frameHeight != previous.height)
}

func resolveCursorFrameSize(frameWidth, frameHeight int, previous desktopCursorStreamState, captureBounds image.Rectangle) (int, int) {
	if frameWidth <= 0 {
		frameWidth = previous.width
		if frameWidth <= 0 {
			frameWidth = captureBounds.Dx()
		}
	}
	if frameHeight <= 0 {
		frameHeight = previous.height
		if frameHeight <= 0 {
			frameHeight = captureBounds.Dy()
		}
	}
	return frameWidth, frameHeight
}
