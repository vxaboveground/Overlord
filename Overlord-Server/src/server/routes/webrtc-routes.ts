import { randomBytes } from "node:crypto";
import { authenticateRequest } from "../../auth";
import { requireClientAccess } from "../../rbac";
import { logger } from "../../logger";
import { issueTurnIceServers } from "../turn-credentials";

const MEDIAMTX_URL = (process.env.OVERLORD_MEDIAMTX_URL || "http://localhost:8889").replace(/\/+$/, "");


const PUBLISH_TOKEN_TTL_MS = 60_000;

type PublishToken = { clientId: string; expiresAt: number };
const publishTokens = new Map<string, PublishToken>();

function prunePublishTokens(now = Date.now()) {
  for (const [t, entry] of publishTokens) {
    if (entry.expiresAt < now) publishTokens.delete(t);
  }
}

export function issueWebrtcPublishToken(clientId: string): string {
  prunePublishTokens();
  const token = randomBytes(24).toString("base64url");
  publishTokens.set(token, { clientId, expiresAt: Date.now() + PUBLISH_TOKEN_TTL_MS });
  return token;
}

export type WebrtcKind = "desktop" | "backstage" | "webcam" | "audio";

export function webrtcStreamPathFor(clientId: string, kind: WebrtcKind): string {
  return `agents/${clientId}/${kind}`;
}

export async function handleWebrtcRoutes(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/webrtc/")) return null;

  if (url.pathname === "/api/webrtc/ice-config") {
    if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    const clientId = url.searchParams.get("clientId") || "";
    if (!/^[A-Za-z0-9_.-]+$/.test(clientId)) return new Response("Bad Request", { status: 400 });
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requireClientAccess(user, clientId);
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
    return Response.json(
      { iceServers: issueTurnIceServers(`${clientId}:viewer`) },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const rest = url.pathname.slice("/api/webrtc/".length);
  // /api/webrtc/agents/<clientId>/<kind>/(whip|whep)[/<sessionId>]
  const match = rest.match(/^(agents\/[A-Za-z0-9_.\-]+\/(?:desktop|backstage|webcam|audio))\/(whip|whep)(\/[A-Za-z0-9_.\-]+)?$/);
  if (!match) return new Response("Not Found", { status: 404 });

  const [, streamPath, kind, sessionSuffix] = match;
  const clientId = streamPath.split("/")[1];

  if (kind === "whip") {
    const authHeader = req.headers.get("authorization") || "";
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    const token = m?.[1] || "";
    const entry = publishTokens.get(token);
    if (!entry || entry.clientId !== clientId || entry.expiresAt < Date.now()) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (req.method === "DELETE") {
      publishTokens.delete(token);
    } else {
      entry.expiresAt = Date.now() + PUBLISH_TOKEN_TTL_MS;
    }
  } else {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    try {
      requireClientAccess(user, clientId);
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }
  }

  const upstreamUrl = `${MEDIAMTX_URL}/${streamPath}/${kind}${sessionSuffix || ""}`;
  const upstreamHeaders = new Headers();
  for (const [k, v] of req.headers) {
    const lower = k.toLowerCase();
    if (lower === "host" || lower === "authorization" || lower === "cookie") continue;
    upstreamHeaders.set(k, v);
  }

  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE") {
    body = await req.arrayBuffer();
  }

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body,
    });
  } catch (err) {
    logger.warn(`[webrtc] upstream fetch failed (${upstreamUrl}): ${(err as Error).message}`);
    return new Response("Bad Gateway", { status: 502 });
  }

  const respHeaders = new Headers(upstreamResp.headers);
  const loc = respHeaders.get("location");
  if (loc) {
    try {
      const abs = new URL(loc, MEDIAMTX_URL);
      respHeaders.set("location", `/api/webrtc${abs.pathname}`);
    } catch { }
  }

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: respHeaders,
  });
}
