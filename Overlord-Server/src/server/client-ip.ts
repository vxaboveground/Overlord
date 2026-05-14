function envFlagEnabled(name: string): boolean {
  const v = String(process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

let trustProxyCache: boolean | null = null;

export function isTrustProxyEnabled(): boolean {
  if (trustProxyCache !== null) return trustProxyCache;
  trustProxyCache =
    envFlagEnabled("OVERLORD_TRUST_PROXY") || envFlagEnabled("OVERLORD_TLS_OFFLOAD");
  return trustProxyCache;
}

export function resetTrustProxyCacheForTests(): void {
  trustProxyCache = null;
}

function isIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isIPv6(ip: string): boolean {
  return ip.includes(":") && /^[0-9a-fA-F:.]+$/.test(ip);
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80:")) return true;
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice("::ffff:".length);
    return isIPv4(v4) && isPrivateIPv4(v4);
  }
  return false;
}

function stripIPv6Brackets(ip: string): string {
  if (ip.startsWith("[") && ip.endsWith("]")) return ip.slice(1, -1);
  return ip;
}

function stripPort(ip: string): string {
  if (ip.startsWith("[")) {
    const close = ip.indexOf("]");
    if (close !== -1) return ip.slice(1, close);
  }
  if (isIPv4(ip)) return ip;
  const colons = (ip.match(/:/g) || []).length;
  if (colons === 1) return ip.split(":")[0];
  return ip;
}

function normalizeCandidate(raw: string): string {
  return stripIPv6Brackets(stripPort(raw.trim()));
}

function isPrivateOrInvalid(ip: string): boolean {
  if (!ip) return true;
  if (isIPv4(ip)) return isPrivateIPv4(ip);
  if (isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

export function resolveForwardedIp(req: Request, fallback: string): string {
  if (!isTrustProxyEnabled()) return fallback;

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => normalizeCandidate(s))
      .filter(Boolean);
    const publicHop = parts.find((p) => !isPrivateOrInvalid(p));
    if (publicHop) return publicHop;
    if (parts.length > 0) return parts[0];
  }

  const xri = req.headers.get("x-real-ip");
  if (xri) {
    const normalized = normalizeCandidate(xri);
    if (normalized) return normalized;
  }

  const cfConnecting = req.headers.get("cf-connecting-ip");
  if (cfConnecting) {
    const normalized = normalizeCandidate(cfConnecting);
    if (normalized) return normalized;
  }

  return fallback;
}

export type RequestServerLike = {
  requestIP: (req: Request) => { address?: string } | null | undefined;
  upgrade: (req: Request, data: any) => boolean;
};

export function wrapServerWithClientIp<T extends RequestServerLike>(server: T): T {
  const wrapped = {
    requestIP: (req: Request) => {
      const peer = server.requestIP(req)?.address || "";
      const real = resolveForwardedIp(req, peer);
      return { address: real };
    },
    upgrade: (req: Request, data: any) => server.upgrade(req, data),
  };
  return new Proxy(server as object, {
    get(target, prop, receiver) {
      if (prop === "requestIP") return wrapped.requestIP;
      if (prop === "upgrade") return wrapped.upgrade;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}
