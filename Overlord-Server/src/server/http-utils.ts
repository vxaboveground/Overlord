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

export function mimeType(path: string) {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}
