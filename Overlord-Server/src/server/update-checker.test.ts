import { describe, test, expect } from "bun:test";
import { parseVersion, isNewerVersion, findHighestSemverTag } from "./update-checker";

describe("parseVersion", () => {
  test("parses semver", () => { expect(parseVersion("1.7.0")).toEqual([1, 7, 0]); });
  test("strips v", () => { expect(parseVersion("v2.0.1")).toEqual([2, 0, 1]); });
  test("null for invalid", () => { expect(parseVersion("bad")).toBeNull(); });
  test("null for empty", () => { expect(parseVersion("")).toBeNull(); });
  test("parses with extra suffix", () => { expect(parseVersion("1.2.3-beta")).toEqual([1, 2, 3]); });
});

describe("isNewerVersion", () => {
  test("major bump", () => { expect(isNewerVersion("1.7.0", "2.0.0")).toBe(true); });
  test("minor bump", () => { expect(isNewerVersion("1.7.0", "1.8.0")).toBe(true); });
  test("patch bump", () => { expect(isNewerVersion("1.7.0", "1.7.1")).toBe(true); });
  test("same", () => { expect(isNewerVersion("1.7.0", "1.7.0")).toBe(false); });
  test("older", () => { expect(isNewerVersion("2.0.0", "1.9.9")).toBe(false); });
  test("invalid local", () => { expect(isNewerVersion("bad", "1.0.0")).toBe(false); });
  test("invalid remote", () => { expect(isNewerVersion("1.0.0", "bad")).toBe(false); });
});

describe("findHighestSemverTag", () => {
  test("finds highest version", () => {
    expect(findHighestSemverTag(["1.0.0", "1.7.1", "1.7.0", "latest", "sha-abc123"])).toBe("1.7.1");
  });

  test("handles v-prefixed tags", () => {
    expect(findHighestSemverTag(["v1.0.0", "v2.1.0", "latest"])).toBe("2.1.0");
  });

  test("returns null for no semver tags", () => {
    expect(findHighestSemverTag(["latest", "main", "sha-abc"])).toBeNull();
  });

  test("returns null for empty list", () => {
    expect(findHighestSemverTag([])).toBeNull();
  });

  test("single semver tag", () => {
    expect(findHighestSemverTag(["1.8.0"])).toBe("1.8.0");
  });

  test("correctly compares across major versions", () => {
    expect(findHighestSemverTag(["1.9.9", "2.0.0", "1.10.0"])).toBe("2.0.0");
  });
});
