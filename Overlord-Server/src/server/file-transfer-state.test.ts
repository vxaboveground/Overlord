import { describe, expect, test } from "bun:test";
import { remotePathBasename } from "./file-transfer-state";

describe("remotePathBasename", () => {
  test("extracts names from Windows paths on any server platform", () => {
    expect(remotePathBasename("C:\\Temp\\overlord-e2e-download.bin"))
      .toBe("overlord-e2e-download.bin");
  });

  test("extracts names from POSIX and mixed-separator paths", () => {
    expect(remotePathBasename("/tmp/archive.tar.gz")).toBe("archive.tar.gz");
    expect(remotePathBasename("C:\\Temp/mixed.bin")).toBe("mixed.bin");
  });
});
