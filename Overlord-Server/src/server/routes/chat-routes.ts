import { authenticateRequest } from "../../auth";
import { getConfig } from "../../config";
import { getChatHistory, getOnlineClientCountForUser } from "../../db";
import { hasPermission } from "../../users";

export async function handleChatRoutes(
  req: Request,
  url: URL,
): Promise<Response | null> {
  if (req.method === "GET" && url.pathname === "/api/chat/history") {
    const user = await authenticateRequest(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const beforeParam = url.searchParams.get("before");
    const limitParam = url.searchParams.get("limit");
    const before = beforeParam ? Number(beforeParam) : undefined;
    const limit = limitParam ? Number(limitParam) : 50;

    if (before !== undefined && (isNaN(before) || before <= 0)) {
      return Response.json({ error: "Invalid 'before' parameter" }, { status: 400 });
    }
    if (isNaN(limit) || limit < 1 || limit > 200) {
      return Response.json({ error: "Invalid 'limit' parameter (1-200)" }, { status: 400 });
    }

    const retDays = getConfig().chat?.retentionDays ?? 30;
    const retMs = retDays > 0 ? retDays * 24 * 60 * 60 * 1000 : undefined;
    const messages = getChatHistory(before, limit, retMs);
    const enriched = messages.map((m) => ({
      ...m,
      onlineClients: m.userId ? getOnlineClientCountForUser(m.userId) : 0,
    }));
    const canWrite = hasPermission(user.role, "chat:write", user.userId);
    return Response.json({ messages: enriched, canWrite });
  }

  return null;
}
