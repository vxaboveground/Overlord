import { authenticateRequest } from "../../auth";
import { AuditAction, logAudit } from "../../auditLog";
import { getConfig } from "../../config";
import { logger } from "../../logger";
import {
  registerUser,
  deleteUser,
  createRegistrationKeys,
  listRegistrationKeys,
  claimRegistrationKey,
  deleteRegistrationKey,
  createPendingRegistration,
  listPendingRegistrations,
  approvePendingRegistration,
  denyPendingRegistration,
  getUserByUsername,
  getTotalUserCount,
  validatePasswordPolicy,
  type UserRole,
} from "../../users";


interface RegRateLimitEntry {
  attempts: number;
  firstAttempt: number;
}

const regRateLimitStore = new Map<string, RegRateLimitEntry>();
const REG_MAX_ATTEMPTS = 5;
const REG_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function isRegRateLimited(ip: string): boolean {
  const entry = regRateLimitStore.get(ip);
  if (!entry) return false;
  const now = Date.now();
  if (now - entry.firstAttempt > REG_WINDOW_MS) {
    regRateLimitStore.delete(ip);
    return false;
  }
  return entry.attempts >= REG_MAX_ATTEMPTS;
}

function recordRegAttempt(ip: string): void {
  const now = Date.now();
  const entry = regRateLimitStore.get(ip);
  if (!entry || now - entry.firstAttempt > REG_WINDOW_MS) {
    regRateLimitStore.set(ip, { attempts: 1, firstAttempt: now });
  } else {
    entry.attempts++;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of regRateLimitStore.entries()) {
    if (now - entry.firstAttempt > REG_WINDOW_MS) {
      regRateLimitStore.delete(ip);
    }
  }
}, 60_000);


type RegistrationRouteDeps = {
  requestIP?: (req: Request) => { address?: string } | null | undefined;
};

function getClientIp(req: Request, deps: RegistrationRouteDeps): string {
  return deps.requestIP?.(req)?.address || "unknown";
}

export async function handleRegistrationRoutes(
  req: Request,
  url: URL,
  deps: RegistrationRouteDeps,
): Promise<Response | null> {
  if (req.method === "GET" && url.pathname === "/api/registration/status") {
    const config = getConfig();
    const mode = config.registration.mode;
    return Response.json({
      enabled: mode !== "off",
      mode: mode === "off" ? "off" : mode,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/register") {
    const config = getConfig();
    const regConfig = config.registration;
    const ip = getClientIp(req, deps);

    if (regConfig.mode === "off") {
      return Response.json({ error: "Registration is disabled" }, { status: 403 });
    }

    if (isRegRateLimited(ip)) {
      return Response.json(
        { error: "Too many registration attempts. Try again later." },
        { status: 429 },
      );
    }
    recordRegAttempt(ip);

    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const keyValue = typeof body?.key === "string" ? body.key.trim() : "";

    if (!username || !password) {
      return Response.json({ error: "Username and password are required" }, { status: 400 });
    }

    if (regConfig.maxUsersTotal > 0) {
      const totalUsers = getTotalUserCount();
      if (totalUsers >= regConfig.maxUsersTotal) {
        return Response.json(
          { error: "Maximum number of registered users has been reached" },
          { status: 403 },
        );
      }
    }

    const existing = getUserByUsername(username);
    if (existing) {
      return Response.json({ error: "Username already exists" }, { status: 409 });
    }

    const defaultRole = regConfig.defaultRole as UserRole;

    if (regConfig.mode === "key") {
      if (!keyValue) {
        return Response.json({ error: "A registration key is required" }, { status: 400 });
      }

      const result = await registerUser(username, password, "key", defaultRole);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      const claimResult = claimRegistrationKey(keyValue, result.userId!);
      if (!claimResult.success) {
        deleteUser(result.userId!);
        return Response.json({ error: claimResult.error }, { status: 400 });
      }

      logAudit({
        timestamp: Date.now(),
        username,
        ip,
        action: AuditAction.COMMAND,
        details: `User registered via key (key: ${claimResult.key.key.substring(0, 8)}...)`,
        success: true,
      });

      logger.info(`[registration] User '${username}' registered via key from ${ip}`);
      return Response.json({ ok: true, message: "Account created successfully. You can now sign in." });
    }

    if (regConfig.mode === "approval") {
      if (username.length < 3 || username.length > 32) {
        return Response.json({ error: "Username must be between 3 and 32 characters" }, { status: 400 });
      }
      if (!/^[a-zA-Z0-9_\-]+$/.test(username)) {
        return Response.json(
          { error: "Username can only contain letters, numbers, hyphens, and underscores" },
          { status: 400 },
        );
      }

      const policyError = validatePasswordPolicy(password);
      if (policyError) {
        return Response.json({ error: policyError }, { status: 400 });
      }

      const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });

      const result = createPendingRegistration(username, passwordHash);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      logAudit({
        timestamp: Date.now(),
        username,
        ip,
        action: AuditAction.COMMAND,
        details: `User registration pending approval`,
        success: true,
      });

      logger.info(`[registration] Pending registration for '${username}' from ${ip}`);
      return Response.json({
        ok: true,
        pending: true,
        message: "Your registration is pending admin approval. You will be able to sign in once approved.",
      });
    }

    if (regConfig.mode === "open") {
      const result = await registerUser(username, password, "open", defaultRole);
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      logAudit({
        timestamp: Date.now(),
        username,
        ip,
        action: AuditAction.COMMAND,
        details: `User registered via open registration`,
        success: true,
      });

      logger.info(`[registration] User '${username}' registered via open registration from ${ip}`);
      return Response.json({ ok: true, message: "Account created successfully. You can now sign in." });
    }

    return Response.json({ error: "Registration is disabled" }, { status: 403 });
  }

  if (req.method === "GET" && url.pathname === "/api/registration/keys") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role !== "admin") return new Response("Forbidden", { status: 403 });

    const keys = listRegistrationKeys();
    return Response.json({ keys });
  }

  if (req.method === "POST" && url.pathname === "/api/registration/keys") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role !== "admin") return new Response("Forbidden", { status: 403 });

    let body: any;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const count = Math.min(100, Math.max(1, Number(body?.count) || 1));
    const label = typeof body?.label === "string" ? body.label : undefined;
    const expiresInHours = typeof body?.expiresInHours === "number" && body.expiresInHours > 0
      ? body.expiresInHours
      : undefined;

    const keys = createRegistrationKeys(count, user.userId, label, expiresInHours);
    const ip = getClientIp(req, deps);

    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip,
      action: AuditAction.COMMAND,
      details: `Generated ${count} registration key(s)${label ? ` (label: ${label})` : ""}`,
      success: true,
    });

    return Response.json({ ok: true, keys });
  }

  if (req.method === "DELETE" && url.pathname.match(/^\/api\/registration\/keys\/\d+$/)) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role !== "admin") return new Response("Forbidden", { status: 403 });

    const keyId = Number(url.pathname.split("/").pop());
    if (!keyId || !Number.isFinite(keyId)) {
      return Response.json({ error: "Invalid key ID" }, { status: 400 });
    }

    const deleted = deleteRegistrationKey(keyId);
    if (!deleted) {
      return Response.json({ error: "Key not found" }, { status: 404 });
    }

    const ip = getClientIp(req, deps);
    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip,
      action: AuditAction.COMMAND,
      details: `Deleted registration key ${keyId}`,
      success: true,
    });

    return Response.json({ ok: true });
  }

  // ── Admin: GET /api/registration/keys/export ──────────────────────────
  if (req.method === "GET" && url.pathname === "/api/registration/keys/export") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role !== "admin") return new Response("Forbidden", { status: 403 });

    const keys = listRegistrationKeys();
    const exportData = keys.map((k) => ({
      key: k.key,
      label: k.label || "",
      status: k.used_by ? "used" : k.expires_at && k.expires_at < Date.now() ? "expired" : "available",
      created_at: new Date(k.created_at).toISOString(),
      expires_at: k.expires_at ? new Date(k.expires_at).toISOString() : "never",
    }));

    return new Response(JSON.stringify(exportData, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="registration-keys-${Date.now()}.json"`,
      },
    });
  }

  // ── Admin: GET /api/registration/pending ──────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/registration/pending") {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role !== "admin") return new Response("Forbidden", { status: 403 });

    const pending = listPendingRegistrations();
    return Response.json({
      pending: pending.map((p) => ({
        id: p.id,
        username: p.username,
        requested_at: p.requested_at,
        status: p.status,
      })),
    });
  }

  // ── Admin: POST /api/registration/pending/:id/approve ─────────────────
  if (req.method === "POST" && url.pathname.match(/^\/api\/registration\/pending\/\d+\/approve$/)) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role !== "admin") return new Response("Forbidden", { status: 403 });

    const pendingId = Number(url.pathname.split("/")[4]);
    if (!pendingId || !Number.isFinite(pendingId)) {
      return Response.json({ error: "Invalid pending ID" }, { status: 400 });
    }

    const config = getConfig();
    const result = await approvePendingRegistration(
      pendingId,
      user.userId,
      config.registration.defaultRole as UserRole,
    );

    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 });
    }

    const ip = getClientIp(req, deps);
    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip,
      action: AuditAction.COMMAND,
      details: `Approved pending registration #${pendingId}`,
      success: true,
    });

    return Response.json({ ok: true, userId: result.userId });
  }

  // ── Admin: POST /api/registration/pending/:id/deny ────────────────────
  if (req.method === "POST" && url.pathname.match(/^\/api\/registration\/pending\/\d+\/deny$/)) {
    const user = await authenticateRequest(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role !== "admin") return new Response("Forbidden", { status: 403 });

    const pendingId = Number(url.pathname.split("/")[4]);
    if (!pendingId || !Number.isFinite(pendingId)) {
      return Response.json({ error: "Invalid pending ID" }, { status: 400 });
    }

    const result = denyPendingRegistration(pendingId, user.userId);
    if (!result.success) {
      return Response.json({ error: result.error }, { status: 400 });
    }

    const ip = getClientIp(req, deps);
    logAudit({
      timestamp: Date.now(),
      username: user.username,
      ip,
      action: AuditAction.COMMAND,
      details: `Denied pending registration #${pendingId}`,
      success: true,
    });

    return Response.json({ ok: true });
  }

  return null;
}
