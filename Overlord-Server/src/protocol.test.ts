import { describe, expect, test } from "bun:test";
import {
  decodeMessage,
  encodeMessage,
  type Frame,
  type Hello,
  type Ping,
} from "./protocol";

const sampleHello: Hello = {
  type: "hello",
  id: "client-123",
  host: "host1",
  os: "windows",
  arch: "amd64",
  version: "v1",
  user: "user1",
  monitors: 1,
  country: "US",
};

describe("protocol encode/decode", () => {
  test("round trips hello via msgpack", () => {
    const encoded = encodeMessage(sampleHello);
    const decoded = decodeMessage(encoded) as Hello;

    expect(decoded.type).toBe("hello");
    expect(decoded.id).toBe(sampleHello.id);
    expect(decoded.os).toBe(sampleHello.os);
    expect(decoded.arch).toBe(sampleHello.arch);
    expect(decoded.country).toBe(sampleHello.country);
  });

  test("decodes JSON strings for compatibility", () => {
    const pingJson = JSON.stringify({ type: "ping", ts: 123 } satisfies Ping);
    const decoded = decodeMessage(pingJson) as Ping;

    expect(decoded.type).toBe("ping");
    expect(decoded.ts).toBe(123);
  });

  test("round trips h264 frame metadata", () => {
    const frame: Frame = {
      type: "frame",
      header: {
        monitor: 1,
        fps: 24,
        format: "h264",
        backstage: true,
      },
      data: new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1e]),
    };

    const encoded = encodeMessage(frame);
    const decoded = decodeMessage(encoded) as Frame;

    expect(decoded.type).toBe("frame");
    expect(decoded.header.format).toBe("h264");
    expect(decoded.header.backstage).toBe(true);
    expect(decoded.header.monitor).toBe(1);
    expect(decoded.header.fps).toBe(24);
    expect(Array.from(decoded.data)).toEqual(Array.from(frame.data));
  });

  test("round trips HEVC frame metadata", () => {
    const frame: Frame = {
      type: "frame",
      header: { monitor: 0, fps: 60, format: "hevc" },
      data: new Uint8Array([0, 0, 0, 1, 0x40, 0x01]),
    };

    const decoded = decodeMessage(encodeMessage(frame)) as Frame;
    expect(decoded.header.format).toBe("hevc");
    expect(Array.from(decoded.data)).toEqual(Array.from(frame.data));
  });
});
