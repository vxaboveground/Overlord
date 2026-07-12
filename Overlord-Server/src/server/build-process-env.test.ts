import { describe, expect, test } from "bun:test";
import { createIsolatedBuildEnv } from "./build-environment";

describe("builder environment isolation", () => {
  test("drops ambient and .env-derived values", () => {
    const env = createIsolatedBuildEnv({
      PATH: "/toolchain/bin",
      HOME: "/builder",
      TEMP: "/tmp",
      JWT_SECRET: "must-not-leak",
      OVERLORD_AGENT_TOKEN: "must-not-leak",
      CUSTOM_BUILD_FLAG: "must-not-leak",
      GOFLAGS: "must-not-affect-build",
    });

    expect(env).toEqual({
      PATH: "/toolchain/bin",
      HOME: "/builder",
      TEMP: "/tmp",
    });
  });
});
