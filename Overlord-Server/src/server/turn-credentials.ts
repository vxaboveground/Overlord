import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

export type OverlordIceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

type TurnConfig = {
  host: string;
  port: number;
  realm: string;
  secret: string;
  ttlSeconds: number;
};

function configuredSecret(): string {
  const direct = process.env.OVERLORD_TURN_SECRET?.trim();
  if (direct) return direct;
  const path = process.env.OVERLORD_TURN_SECRET_FILE?.trim();
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function loadTurnConfig(): TurnConfig | null {
  const host = (process.env.OVERLORD_TURN_HOST || "").trim();
  const secret = configuredSecret();
  if (!host || !secret || /[\s\/?#]/.test(host)) return null;
  const portValue = Number(process.env.OVERLORD_TURN_PORT || 3478);
  const port = Number.isInteger(portValue) && portValue > 0 && portValue <= 65535 ? portValue : 3478;
  const ttlValue = Number(process.env.OVERLORD_TURN_CREDENTIAL_TTL_SECONDS || 3600);
  const ttlSeconds = Math.max(300, Math.min(86400, Number.isFinite(ttlValue) ? Math.floor(ttlValue) : 3600));
  return {
    host,
    port,
    realm: (process.env.OVERLORD_TURN_REALM || "overlord").trim() || "overlord",
    secret,
    ttlSeconds,
  };
}

function safeIdentity(identity: string): string {
  return identity.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96) || "peer";
}

export function buildTurnIceServers(config: TurnConfig, identity: string, nowMs = Date.now()): OverlordIceServer[] {
  const expiresAt = Math.floor(nowMs / 1000) + config.ttlSeconds;
  const username = `${expiresAt}:${safeIdentity(identity)}`;
  const credential = createHmac("sha1", config.secret).update(username).digest("base64");
  const authority = `${config.host}:${config.port}`;
  return [
    { urls: [`stun:${authority}`] },
    {
      urls: [`turn:${authority}?transport=udp`, `turn:${authority}?transport=tcp`],
      username,
      credential,
    },
  ];
}

export function issueTurnIceServers(identity: string, nowMs = Date.now()): OverlordIceServer[] {
  const config = loadTurnConfig();
  return config ? buildTurnIceServers(config, identity, nowMs) : [];
}
