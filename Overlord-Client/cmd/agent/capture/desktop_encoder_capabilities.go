package capture

type DesktopEncoderProfile struct {
	MaxHeight int      `msgpack:"maxHeight" json:"maxHeight"`
	Width     int      `msgpack:"width" json:"width"`
	Height    int      `msgpack:"height" json:"height"`
	FPS       int      `msgpack:"fps" json:"fps"`
	Label     string   `msgpack:"label" json:"label"`
	Providers []string `msgpack:"providers" json:"providers"`
}

type DesktopCodecCapability struct {
	Codec      string   `msgpack:"codec" json:"codec"`
	Encoders   []string `msgpack:"encoders,omitempty" json:"encoders,omitempty"`
	Transports []string `msgpack:"transports" json:"transports"`
	Hardware   bool     `msgpack:"hardware,omitempty" json:"hardware,omitempty"`
}

type DesktopEncoderCapabilities struct {
	Probed   bool                     `msgpack:"probed" json:"probed"`
	Display  int                      `msgpack:"display" json:"display"`
	Profiles []DesktopEncoderProfile  `msgpack:"profiles" json:"profiles"`
	Codecs   []DesktopCodecCapability `msgpack:"codecs" json:"codecs"`
	Detail   string                   `msgpack:"detail,omitempty" json:"detail,omitempty"`
}

func completeDesktopEncoderCapabilities(caps DesktopEncoderCapabilities) DesktopEncoderCapabilities {
	encoders := make([]string, 0)
	hardware := false
	for _, profile := range caps.Profiles {
		for _, provider := range profile.Providers {
			encoders = appendDesktopUniqueString(encoders, provider)
			if provider != "" && provider != "Software H.264 / JPEG" {
				hardware = true
			}
		}
	}
	caps.Codecs = []DesktopCodecCapability{
		{Codec: "jpeg", Encoders: []string{"Software JPEG"}, Transports: []string{"websocket"}},
		{Codec: "raw", Encoders: []string{"Uncompressed"}, Transports: []string{"websocket"}},
	}
	if hevcAvailable() {
		caps.Codecs = append([]DesktopCodecCapability{{
			Codec: "hevc", Encoders: []string{"NVIDIA NVENC"},
			Transports: []string{"websocket"}, Hardware: true,
		}}, caps.Codecs...)
	}
	if h264Available() {
		if len(encoders) == 0 {
			encoders = []string{"Software H.264"}
		}
		caps.Codecs = append([]DesktopCodecCapability{{
			Codec: "h264", Encoders: encoders,
			Transports: []string{"websocket", "webrtc"}, Hardware: hardware,
		}}, caps.Codecs...)
	}
	return caps
}

func appendDesktopUniqueString(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}
