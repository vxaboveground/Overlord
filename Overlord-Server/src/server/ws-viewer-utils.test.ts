import { describe, expect, test } from "bun:test";
import { buildViewerFrameBuffer } from "./ws-viewer-utils";

describe("viewer frame protocol", () => {
  test("encodes HEVC as compact frame format 5", () => {
    const payload = new Uint8Array([0, 0, 0, 1, 0x40]);
    const frame = buildViewerFrameBuffer(payload, {
      format: "hevc",
      monitor: 2,
      fps: 60,
      width: 1920,
      height: 1080,
    });

    expect(frame[3]).toBe(2);
    expect(frame[4]).toBe(2);
    expect(frame[5]).toBe(60);
    expect(frame[6]).toBe(5);
    expect(frame.slice(12)).toEqual(payload);
  });
});
