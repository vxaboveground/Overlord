export function getFileExt(name = "") {
  const idx = name.lastIndexOf(".");
  if (idx < 0 || idx === name.length - 1) return "";
  return name.slice(idx + 1).toLowerCase();
}

export const PREVIEW_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);
export const PREVIEW_PDF_EXTS = new Set(["pdf"]);
export const PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

const HIGHLIGHT_FILENAME_MAP = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  "nginx.conf": "nginx",
  ".env": "bash",
};

const HIGHLIGHT_EXTENSION_MAP = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  py: "python", pyw: "python", rb: "ruby", java: "java",
  cpp: "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp", hxx: "cpp",
  c: "c", h: "c", cs: "csharp", php: "php", phtml: "php",
  go: "go", rs: "rust",
  sh: "bash", bash: "bash", zsh: "bash", ksh: "bash",
  bat: "powershell", cmd: "powershell", ps1: "powershell", psm1: "powershell", psd1: "powershell",
  json: "json", jsonc: "json", json5: "json",
  xml: "xml", svg: "xml", xsl: "xml", xslt: "xml", plist: "xml",
  html: "xml", htm: "xml", xhtml: "xml", vue: "xml", svelte: "xml",
  css: "css", scss: "scss", sass: "scss", sql: "sql",
  yaml: "yaml", yml: "yaml", md: "markdown", markdown: "markdown",
  ini: "ini", cfg: "ini", properties: "ini", toml: "ini",
  diff: "diff", patch: "diff", dockerfile: "dockerfile", makefile: "makefile", nginx: "nginx",
};

export function getHighlightLanguage(name = "") {
  const fileName = name.split(/[\\/]/).pop()?.toLowerCase() || "";
  if (HIGHLIGHT_FILENAME_MAP[fileName]) return HIGHLIGHT_FILENAME_MAP[fileName];
  if (fileName.startsWith("dockerfile.")) return "dockerfile";
  if (fileName.startsWith(".env.")) return "bash";
  return HIGHLIGHT_EXTENSION_MAP[getFileExt(fileName)] || "plaintext";
}

export const KNOWN_BINARY_EXTS = new Set([
  "mp4", "avi", "mkv", "mov", "wmv", "flv", "webm", "m4v",
  "mp3", "wav", "flac", "ogg", "aac", "wma", "m4a",
  "exe", "msi", "com", "app", "appimage",
  "dll", "so", "dylib", "lib",
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz",
  "db", "sqlite", "sqlite3", "mdb",
  "ttf", "otf", "woff", "woff2", "eot",
  "iso", "img", "vhd", "vmdk",
]);

const IMAGE_MIME_MAP = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

export function isPreviewable(name) {
  const ext = getFileExt(name);
  return PREVIEW_IMAGE_EXTS.has(ext) || PREVIEW_PDF_EXTS.has(ext);
}

export function getPreviewMimeType(name) {
  const ext = getFileExt(name);
  if (PREVIEW_PDF_EXTS.has(ext)) return "application/pdf";
  return IMAGE_MIME_MAP[ext] || null;
}

export function shouldShowParentDirectory(path) {
  if (!path || path === ".") {
    return false;
  }

  return true;
}

export function getParentPath(path) {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((p) => p);

  if (parts.length === 1 && parts[0].match(/^[A-Za-z]:$/)) {
    return ".";
  }

  if (parts.length <= 1) {
    return ".";
  }

  parts.pop();
  let parentPath = parts.join("/");

  if (parentPath.match(/^[A-Za-z]:?$/)) {
    return parentPath.replace(/^([A-Za-z]):?$/, "$1:\\");
  }

  return parentPath || ".";
}

export function formatBytes(bytes) {
  if (bytes === 0 || bytes === 0n) return "0 B";
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  if (typeof bytes === "bigint") {
    const k = 1024n;
    let i = 0;
    let value = bytes;
    while (value >= k && i < sizes.length - 1) {
      value /= k;
      i += 1;
    }
    return `${value.toString()} ${sizes[i]}`;
  }
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

export function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
