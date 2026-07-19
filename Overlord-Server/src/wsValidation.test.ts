import { describe, expect, test } from "bun:test";
import {
  ALLOWED_CLIENT_MESSAGE_TYPES,
  getMaxPayloadLimit,
  getMessageByteLength,
  isAllowedClientMessageType,
} from "./wsValidation";

describe("wsValidation", () => {
  test("allowed client message types include core types", () => {
    expect(ALLOWED_CLIENT_MESSAGE_TYPES.has("hello")).toBe(true);
    expect(ALLOWED_CLIENT_MESSAGE_TYPES.has("ping")).toBe(true);
    expect(ALLOWED_CLIENT_MESSAGE_TYPES.has("frame")).toBe(true);
    expect(ALLOWED_CLIENT_MESSAGE_TYPES.has("desktop_cursor")).toBe(true);
  });

  test("unknown client message types are rejected", () => {
    expect(isAllowedClientMessageType("not_a_real_type")).toBe(false);
  });

  test("getMessageByteLength handles string and binary", () => {
    const textLen = getMessageByteLength("hello");
    const buffer = new Uint8Array([1, 2, 3, 4]);
    const arrayBuf = buffer.buffer;

    expect(textLen).toBe(5);
    expect(getMessageByteLength(buffer)).toBe(4);
    expect(getMessageByteLength(arrayBuf)).toBe(4);
  });

  test("getMaxPayloadLimit uses client limit when role is client", () => {
    expect(getMaxPayloadLimit("client", 10, 1)).toBe(10);
    expect(getMaxPayloadLimit("viewer", 10, 1)).toBe(1);
    expect(getMaxPayloadLimit(undefined, 10, 1)).toBe(1);
  });
});
