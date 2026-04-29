import { authenticateRequest } from "../../auth";
import {
  createAutoScript,
  deleteAutoScript,
  listAutoScripts,
  type AutoScriptTrigger,
  updateAutoScript,
} from "../../db";
import { requirePermission } from "../../rbac";
import { AUTO_SCRIPT_TRIGGERS, ALLOWED_SCRIPT_TYPES, ALLOWED_OS_FILTERS } from "../validation-constants";
import { v4 as uuidv4 } from "uuid";

export async function handleAutoScriptsRoutes(
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (req.method === "GET" && url.pathname === "/api/auto-scripts") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    try {
      requirePermission(user, "clients:control");
    } catch (error) {
      if (error instanceof Response) return error;
      return new Response("Forbidden", { status: 403 });
    }

    return Response.json({ items: listAutoScripts() });
  }

  if (req.method === "POST" && url.pathname === "/api/auto-scripts") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const name = String(body?.name || "").trim();
    const triggerRaw = String(body?.trigger || "").trim() as AutoScriptTrigger;
    const script = String(body?.script || "");
    const scriptTypeRaw = String(body?.scriptType || "powershell").trim();
    const enabled = typeof body?.enabled === "boolean" ? body.enabled : true;
    const osFilterRaw = Array.isArray(body?.osFilter) ? body.osFilter : [];
    const osFilter = osFilterRaw.filter((v: unknown) => typeof v === "string" && ALLOWED_OS_FILTERS.has(v));

    if (!name) {
      return Response.json({ error: "Name is required" }, { status: 400 });
    }
    if (!script.trim()) {
      return Response.json({ error: "Script is required" }, { status: 400 });
    }
    if (!AUTO_SCRIPT_TRIGGERS.has(triggerRaw)) {
      return Response.json({ error: "Invalid trigger" }, { status: 400 });
    }

    const scriptType = ALLOWED_SCRIPT_TYPES.has(scriptTypeRaw)
      ? scriptTypeRaw
      : "powershell";

    const item = createAutoScript({
      id: uuidv4(),
      name,
      trigger: triggerRaw,
      script,
      scriptType,
      enabled,
      osFilter,
    });

    return Response.json({ ok: true, item });
  }

  const autoScriptMatch = url.pathname.match(/^\/api\/auto-scripts\/(.+)$/);
  if (autoScriptMatch && req.method === "PUT") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const triggerRaw = body?.trigger ? String(body.trigger).trim() : undefined;
    if (triggerRaw && !AUTO_SCRIPT_TRIGGERS.has(triggerRaw as AutoScriptTrigger)) {
      return Response.json({ error: "Invalid trigger" }, { status: 400 });
    }

    const scriptTypeRaw = body?.scriptType ? String(body.scriptType).trim() : undefined;
    const scriptType = scriptTypeRaw
      ? ALLOWED_SCRIPT_TYPES.has(scriptTypeRaw)
        ? scriptTypeRaw
        : "powershell"
      : undefined;

    const osFilterRaw = Array.isArray(body?.osFilter) ? body.osFilter : undefined;
    const osFilter = osFilterRaw
      ? osFilterRaw.filter((v: unknown) => typeof v === "string" && ALLOWED_OS_FILTERS.has(v))
      : undefined;

    const updated = updateAutoScript(autoScriptMatch[1], {
      name: body?.name ? String(body.name).trim() : undefined,
      trigger: triggerRaw as AutoScriptTrigger | undefined,
      script: body?.script ? String(body.script) : undefined,
      scriptType,
      enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
      osFilter,
    });

    if (!updated) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return Response.json({ ok: true, item: updated });
  }

  if (autoScriptMatch && req.method === "DELETE") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (user.role !== "admin") {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    deleteAutoScript(autoScriptMatch[1]);
    return Response.json({ ok: true });
  }

  return null;
}
