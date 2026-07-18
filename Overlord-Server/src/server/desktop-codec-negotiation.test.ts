import { describe, expect, test } from "bun:test";
import { negotiateDesktopCodec } from "./desktop-codec-negotiation";

const encoders = [
  { codec: "hevc", transports: ["websocket"] },
  { codec: "h264", transports: ["websocket", "webrtc"] },
  { codec: "jpeg", transports: ["websocket"] },
];

describe("desktop codec negotiation", () => {
  test("selects the first mutually supported preferred codec", () => {
    expect(negotiateDesktopCodec({
      encoderCodecs: encoders,
      decoderCodecs: ["hevc", "h264", "jpeg"],
      preferredCodecs: ["hevc", "h264", "jpeg"],
      transport: "websocket",
    })).toEqual({
      selectedCodec: "hevc",
      fallbackCodecs: ["hevc", "h264", "jpeg"],
      transport: "websocket",
    });
  });

  test("filters codecs that are unavailable on WebRTC", () => {
    expect(negotiateDesktopCodec({
      encoderCodecs: encoders,
      decoderCodecs: ["hevc", "h264", "jpeg"],
      preferredCodecs: ["hevc", "h264", "jpeg"],
      transport: "p2p",
    })).toEqual({
      selectedCodec: "h264",
      fallbackCodecs: ["h264"],
      transport: "webrtc",
    });
  });

  test("falls back to JPEG when H.264 decoding is unavailable", () => {
    const result = negotiateDesktopCodec({
      encoderCodecs: encoders,
      decoderCodecs: ["jpeg"],
      preferredCodecs: ["h264", "jpeg"],
      transport: "websocket",
    });
    expect(result.selectedCodec).toBe("jpeg");
    expect(result.fallbackCodecs).toEqual(["jpeg"]);
  });

  test("returns no codec instead of selecting an incompatible transport", () => {
    const result = negotiateDesktopCodec({
      encoderCodecs: encoders,
      decoderCodecs: ["jpeg"],
      preferredCodecs: ["jpeg"],
      transport: "webrtc",
    });
    expect(result.selectedCodec).toBe("");
    expect(result.fallbackCodecs).toEqual([]);
  });

  test("does not re-add a codec the viewer explicitly omitted", () => {
    const result = negotiateDesktopCodec({
      encoderCodecs: encoders,
      decoderCodecs: ["h264", "jpeg"],
      preferredCodecs: ["jpeg"],
      transport: "websocket",
    });
    expect(result.fallbackCodecs).toEqual(["jpeg"]);
  });
});
