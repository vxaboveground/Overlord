import { SignJWT, jwtVerify } from "jose";
import { getConfig } from "./config";
import {
  verifyPassword,
  getUserByUsername,
  getUserById,
  type User,
  type UserRole,
} from "./users";
import {
  persistRevokedToken,
  isTokenRevoked,
  pruneExpiredRevokedTokens,
  createSession,
  hashTokenForSession,
  revokeSessionByTokenHash,
  updateSessionActivity,
  pruneExpiredSessions,
} from "./db";

const JWT_ISSUER = "overlord-server";
const JWT_AUDIENCE = "overlord-client";

const tokenCache = new Map<
  string,
  { payload: JWTPayload; timestamp: number }
>();
const TOKEN_CACHE_TTL = 500;

function getSecretKey(): Uint8Array {
  const config = getConfig();
  return new TextEncoder().encode(config.auth.jwtSecret);
}

export function getSessionTtlHours(): number {
  const configured = Number(getConfig().security.sessionTtlHours) || 168;
  return Math.min(24 * 30, Math.max(1, configured));
}

export function getSessionTtlSeconds(): number {
  return getSessionTtlHours() * 60 * 60;
}

export interface JWTPayload {
  sub: string;
  userId: number;
  role: UserRole;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

export interface AuthenticatedUser {
  username: string;
  userId: number;
  role: UserRole;
  mustChangePassword?: boolean;
}

function mayUseApiBeforePasswordChange(pathname: string, userId: number): boolean {
  return pathname === "/api/auth/me"
    || pathname === "/api/auth/logout"
    || pathname === `/api/users/${userId}/password`;
}

export async function generateToken(
  user: User,
  sessionMeta?: { ip?: string; userAgent?: string },
): Promise<string> {
  const expiration = `${getSessionTtlHours()}h`;
  const token = await new SignJWT({
    sub: user.username,
    userId: user.id,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(expiration)
    .sign(getSecretKey());

  const tokenHash = hashTokenForSession(token);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + getSessionTtlSeconds();

  try {
    createSession({
      id: crypto.randomUUID(),
      userId: user.id,
      tokenHash,
      ip: sessionMeta?.ip || null,
      userAgent: sessionMeta?.userAgent || null,
      createdAt: now,
      expiresAt,
    });
  } catch (e) {
    console.error("[auth] Failed to create session record:", e);
  }

  return token;
}

export async function verifyToken(token: string): Promise<JWTPayload | null> {
  if (isTokenRevoked(token)) {
    return null;
  }

  const cached = tokenCache.get(token);
  if (cached) {
    const age = Date.now() - cached.timestamp;
    if (age < TOKEN_CACHE_TTL) {
      return cached.payload;
    } else {
      tokenCache.delete(token);
    }
  }

  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    const jwtPayload: JWTPayload = {
      sub: payload.sub as string,
      userId: payload.userId as number,
      role: payload.role as UserRole,
      iat: payload.iat as number,
      exp: payload.exp as number,
      iss: payload.iss as string,
      aud: payload.aud as string,
    };

    tokenCache.set(token, { payload: jwtPayload, timestamp: Date.now() });

    return jwtPayload;
  } catch (error) {
    return null;
  }
}

export function revokeToken(token: string): void {
  let expiresAt = Math.floor(Date.now() / 1000) + getSessionTtlSeconds();
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      if (typeof payload.exp === "number") expiresAt = payload.exp;
    }
  } catch { /* keep fallback */ }

  persistRevokedToken(token, expiresAt);
  tokenCache.delete(token);

  const tokenHash = hashTokenForSession(token);
  revokeSessionByTokenHash(tokenHash);

  console.log("[auth] Token revoked (persisted)");
}

export async function cleanupBlacklist(): Promise<void> {
  const pruned = pruneExpiredRevokedTokens();
  const prunedSessions = pruneExpiredSessions();

  const cacheNow = Date.now();
  let cacheCleared = 0;
  for (const [token, entry] of tokenCache.entries()) {
    if (cacheNow - entry.timestamp > TOKEN_CACHE_TTL * 2) {
      tokenCache.delete(token);
      cacheCleared++;
    }
  }

  const activityCutoff = cacheNow - SESSION_ACTIVITY_THROTTLE * 2;
  for (const [token, ts] of lastActivityUpdate.entries()) {
    if (ts < activityCutoff) {
      lastActivityUpdate.delete(token);
    }
  }

  if (pruned > 0 || cacheCleared > 0 || prunedSessions > 0) {
    console.log(
      `[auth] Cleaned up ${pruned} expired tokens from blacklist, ${prunedSessions} expired sessions, ${cacheCleared} from cache`,
    );
  }
}

setInterval(cleanupBlacklist, 60 * 60 * 1000);

export async function authenticateUser(
  username: string,
  password: string,
): Promise<User | null> {
  return await verifyPassword(username, password);
}

export function extractTokenFromHeader(
  authHeader: string | null,
): string | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.substring(7);
}

export function extractTokenFromCookie(
  cookieHeader: string | null,
): string | null {
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(/;\s*/);
  for (const cookie of cookies) {
    const [name, value] = cookie.split("=");
    if (name === "overlord_token") {
      return value;
    }
  }

  return null;
}

const SESSION_ACTIVITY_THROTTLE = 60_000; // 60s
const lastActivityUpdate = new Map<string, number>();

export async function authenticateRequest(
  req: Request,
): Promise<AuthenticatedUser | null> {
  const authHeader = req.headers.get("Authorization");
  let token = extractTokenFromHeader(authHeader);

  if (!token) {
    const cookieHeader = req.headers.get("Cookie");
    token = extractTokenFromCookie(cookieHeader);
  }

  if (!token) {
    return null;
  }

  const payload = await verifyToken(token);
  if (!payload) {
    return null;
  }

  const user = getUserById(payload.userId);
  if (!user) {
    return null;
  }

  const pathname = new URL(req.url).pathname;
  if (
    Boolean(user.must_change_password)
    && pathname.startsWith("/api/")
    && !mayUseApiBeforePasswordChange(pathname, user.id)
  ) {
    return null;
  }

  const now = Date.now();
  const lastUpdate = lastActivityUpdate.get(token) || 0;
  if (now - lastUpdate > SESSION_ACTIVITY_THROTTLE) {
    lastActivityUpdate.set(token, now);
    try {
      updateSessionActivity(hashTokenForSession(token));
    } catch { }
  }

  return {
    username: payload.sub,
    userId: payload.userId,
    role: user.role,
    mustChangePassword: Boolean(user.must_change_password),
  };
}

export async function getUserFromRequest(
  req: Request,
): Promise<AuthenticatedUser | null> {
  return await authenticateRequest(req);
}

export function extractTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  let token = extractTokenFromHeader(authHeader);

  if (!token) {
    const cookieHeader = req.headers.get("Cookie");
    token = extractTokenFromCookie(cookieHeader);
  }

  return token;
}
