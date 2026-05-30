export function getFileExt(name = "") {
  const idx = name.lastIndexOf(".");
  if (idx < 0 || idx === name.length - 1) return "";
  return name.slice(idx + 1).toLowerCase();
}

export const PREVIEW_IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);
export const PREVIEW_PDF_EXTS = new Set(["pdf"]);
export const PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

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
