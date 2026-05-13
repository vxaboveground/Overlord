/**
 * Copies vendor assets for the Tauri Desktop app into src/vendor/.
 * Usage: bun run scripts/vendor.ts
 */

import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, copyFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const NM = path.join(ROOT, "node_modules");
const VENDOR = path.join(ROOT, "src", "vendor");

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function copyFile(src: string, dest: string) {
  ensureDir(path.dirname(dest));
  copyFileSync(src, dest);
}

function copyFilesFiltered(srcDir: string, destDir: string, filter: (name: string) => boolean) {
  ensureDir(destDir);
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isFile() && filter(entry.name)) {
      copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
    }
  }
}

if (existsSync(VENDOR)) rmSync(VENDOR, { recursive: true });
ensureDir(VENDOR);

// Font Awesome
const faRoot = path.join(NM, "@fortawesome", "fontawesome-free");
copyFile(path.join(faRoot, "css", "all.min.css"), path.join(VENDOR, "fontawesome", "css", "all.min.css"));
cpSync(path.join(faRoot, "webfonts"), path.join(VENDOR, "fontawesome", "webfonts"), { recursive: true });

// Inter (400, 500, 600, 700)
const interRoot = path.join(NM, "@fontsource", "inter");
for (const w of ["400", "500", "600", "700"]) {
  copyFile(path.join(interRoot, `${w}.css`), path.join(VENDOR, "inter", `${w}.css`));
}
copyFilesFiltered(path.join(interRoot, "files"), path.join(VENDOR, "inter", "files"), (n) =>
  /^inter-.*-(400|500|600|700)-normal\.(woff2|woff)$/.test(n),
);

console.log("Desktop vendor assets ready");
