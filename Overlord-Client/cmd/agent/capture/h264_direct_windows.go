//go:build windows

package capture

import (
	"time"

	"overlord-client/cmd/agent/webrtcpub"
	"overlord-client/cmd/agent/wire"
)

func tryBuildDirectH264Frame(display int) (wire.Frame, time.Duration, time.Duration, bool, error) {
	codec := blockCodec()
	if (codec != "h264" && codec != "hevc") || (codec == "h264" && useDesktopSoftwareH264()) || !useDesktopDuplication() {
		return wire.Frame{}, 0, 0, false, nil
	}
	forceKeyframe := webrtcpub.ConsumeKeyframeRequest()
	var data []byte
	var width, height int
	var captureDur, encodeDur time.Duration
	var used bool
	var err error
	if codec == "hevc" {
		data, width, height, captureDur, encodeDur, used, err = captureDisplayDXGIHEVC(display, forceKeyframe)
	} else {
		data, width, height, captureDur, encodeDur, used, err = captureDisplayDXGIH264(display, forceKeyframe)
	}
	if !used || err != nil {
		return wire.Frame{}, captureDur, encodeDur, used, err
	}
	if len(data) == 0 {
		return wire.Frame{}, captureDur, encodeDur, true, nil
	}
	now := time.Now()
	lastKeyframe.Store(now.UnixNano())
	statFullFrames.Add(1)
	return wire.Frame{Type: "frame", Header: wire.FrameHeader{Monitor: display, FPS: 0, Format: codec, Width: width, Height: height}, Data: data}, captureDur, encodeDur, true, nil
}
