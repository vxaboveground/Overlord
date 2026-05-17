import { describe, expect, test } from "bun:test";
import { generateBuildMutex, sanitizeMutex, sanitizeOutputName } from "./build-utils";

describe("generateBuildMutex", () => {
  test("returns string of requested length", () => {
    expect(generateBuildMutex(24)).toHaveLength(24);
    expect(generateBuildMutex(1)).toHaveLength(1);
    expect(generateBuildMutex(64)).toHaveLength(64);
  });

  test("defaults to length 24", () => {
    expect(generateBuildMutex()).toHaveLength(24);
  });

  test("only uses allowed alphabet characters", () => {
    const value = generateBuildMutex(256);
    expect(value).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  test("produces different values across calls", () => {
    const a = generateBuildMutex(24);
    const b = generateBuildMutex(24);
    expect(a).not.toBe(b);
  });

  test("result passes sanitizeMutex", () => {
    expect(sanitizeMutex(generateBuildMutex(24))).toBeDefined();
  });
});

describe("sanitizeMutex", () => {
  test("returns undefined for falsy input", () => {
    expect(sanitizeMutex(undefined)).toBeUndefined();
    expect(sanitizeMutex("")).toBeUndefined();
  });

  test("returns undefined for whitespace-only input", () => {
    expect(sanitizeMutex("   ")).toBeUndefined();
    expect(sanitizeMutex("\t\n")).toBeUndefined();
  });

  test("trims surrounding whitespace", () => {
    expect(sanitizeMutex("  abc  ")).toBe("abc");
  });

  test("accepts allowed characters", () => {
    expect(sanitizeMutex("Abc.123_-xyz")).toBe("Abc.123_-xyz");
  });

  test("rejects spaces inside the value", () => {
    expect(() => sanitizeMutex("ab cd")).toThrow(/Mutex must be/);
  });

  test("rejects disallowed punctuation", () => {
    expect(() => sanitizeMutex("abc/def")).toThrow();
    expect(() => sanitizeMutex("abc@def")).toThrow();
    expect(() => sanitizeMutex("abc#def")).toThrow();
  });

  test("enforces max length of 64", () => {
    expect(sanitizeMutex("a".repeat(64))).toBe("a".repeat(64));
    expect(() => sanitizeMutex("a".repeat(65))).toThrow();
  });
});

describe("sanitizeOutputName", () => {
  test("accepts plain filenames", () => {
    expect(sanitizeOutputName("agent.exe")).toBe("agent.exe");
    expect(sanitizeOutputName("my-build_v2.0.bin")).toBe("my-build_v2.0.bin");
  });

  test("strips path components from traversal attempts", () => {
    // path.basename removes the directory portion, neutralizing traversal.
    // The returned value still has to match the allowed-character set.
    expect(sanitizeOutputName("../etc/passwd")).toBe("passwd");
    expect(sanitizeOutputName("/etc/shadow")).toBe("shadow");
  });

  test("rejects when basename itself contains a disallowed character", () => {
    expect(() => sanitizeOutputName("bad name")).toThrow(/Invalid output filename/);
    expect(() => sanitizeOutputName("weird$.bin")).toThrow();
  });

  test("rejects names with disallowed characters", () => {
    expect(() => sanitizeOutputName("agent name.exe")).toThrow();
    expect(() => sanitizeOutputName("agent$.exe")).toThrow();
    expect(() => sanitizeOutputName("agent*.exe")).toThrow();
  });

  test("rejects empty result", () => {
    expect(() => sanitizeOutputName("")).toThrow();
  });
});
