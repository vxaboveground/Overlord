import { describe, expect, test } from "bun:test";
import { sanitizePluginId } from "./plugin-utils";

describe("sanitizePluginId", () => {
  test("accepts a plain id", () => {
    expect(sanitizePluginId("my-plugin")).toBe("my-plugin");
    expect(sanitizePluginId("plugin.v2_0")).toBe("plugin.v2_0");
  });

  test("strips path components to defend against traversal", () => {
    expect(sanitizePluginId("../../../etc/passwd")).toBe("passwd");
    expect(sanitizePluginId("/var/log/syslog")).toBe("syslog");
    expect(sanitizePluginId("nested/dir/plugin")).toBe("plugin");
  });

  test("strips disallowed characters from the basename", () => {
    expect(sanitizePluginId("hello world!")).toBe("helloworld");
    expect(sanitizePluginId("plug$in@123")).toBe("plugin123");
  });

  test("throws when nothing survives sanitization", () => {
    expect(() => sanitizePluginId("")).toThrow(/Invalid plugin id/);
    expect(() => sanitizePluginId("!!!@@@")).toThrow(/Invalid plugin id/);
    expect(() => sanitizePluginId("/")).toThrow(/Invalid plugin id/);
  });
});
