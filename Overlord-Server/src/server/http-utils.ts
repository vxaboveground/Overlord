import { SECURITY_HEADERS } from "./http-security";

export function secureHeaders(contentType?: string) {
  return {
    ...SECURITY_HEADERS,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

export function securePluginHeaders() {
  return {
    ...SECURITY_HEADERS,
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss: ws:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  };
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function mimeType(filePath: string) {
  const dot = filePath.lastIndexOf(".");
  if (dot !== -1) return MIME_TYPES[filePath.slice(dot).toLowerCase()] ?? "application/octet-stream";
  return "application/octet-stream";
}
