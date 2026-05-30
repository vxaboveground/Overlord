import type { AuthenticatedUser } from "../../auth";
import {
  deleteBuildProfileForUser,
  listBuildProfilesForUser,
  saveBuildProfileForUser,
} from "../../db";
import { requirePermission } from "../../rbac";

export async function handleBuildProfileRoutes(
  req: Request,
  url: URL,
  user: AuthenticatedUser,
): Promise<Response | null> {
  if (req.method === "GET" && url.pathname === "/api/build/profiles") {
    requirePermission(user, "clients:build");

    const profiles = listBuildProfilesForUser(user.userId).map((p) => {
      let parsedConfig: any = {};
      try {
        parsedConfig = JSON.parse(p.profileJson);
      } catch {
        parsedConfig = {};
      }
      return {
        name: p.name,
        config: parsedConfig,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });
    return Response.json({ profiles });
  }

  if (req.method === "POST" && url.pathname === "/api/build/profiles") {
    requirePermission(user, "clients:build");

    const body = await req.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const config = body?.config;

    if (!name || name.length > 64 || !/^[A-Za-z0-9 _.-]+$/.test(name)) {
      return Response.json(
        { error: "Invalid profile name (1-64 chars, letters/numbers/space/._-)" },
        { status: 400 },
      );
    }

    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return Response.json({ error: "Invalid profile config" }, { status: 400 });
    }

    const MAX_PROFILES_PER_USER = 50;
    const existingProfiles = listBuildProfilesForUser(user.userId);
    const hasExistingWithSameName = existingProfiles.some((p) => p.name === name);
    if (!hasExistingWithSameName && existingProfiles.length >= MAX_PROFILES_PER_USER) {
      return Response.json(
        { error: `Profile limit reached (${MAX_PROFILES_PER_USER} max)` },
        { status: 400 },
      );
    }

    let profileJson = "{}";
    try {
      profileJson = JSON.stringify(config);
    } catch {
      return Response.json({ error: "Profile config must be JSON serializable" }, { status: 400 });
    }

    if (profileJson.length > 512 * 1024) {
      return Response.json({ error: "Profile config too large (max 512KB)" }, { status: 400 });
    }

    saveBuildProfileForUser(user.userId, name, profileJson);
    return Response.json({ success: true });
  }

  if (req.method === "DELETE" && url.pathname.match(/^\/api\/build\/profiles\/.+$/)) {
    requirePermission(user, "clients:build");

    const encodedName = url.pathname.split("/api/build/profiles/")[1] || "";
    let name = "";
    try {
      name = decodeURIComponent(encodedName).trim();
    } catch {
      return Response.json({ error: "Invalid profile name" }, { status: 400 });
    }
    if (!name) {
      return Response.json({ error: "Invalid profile name" }, { status: 400 });
    }

    const deleted = deleteBuildProfileForUser(user.userId, name);
    if (!deleted) {
      return Response.json({ error: "Profile not found" }, { status: 404 });
    }
    return Response.json({ success: true });
  }

  return null;
}
