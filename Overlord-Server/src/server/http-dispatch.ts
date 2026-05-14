import { wrapServerWithClientIp, type RequestServerLike } from "./client-ip";

export type RouteHandler = (req: Request, url: URL, server: unknown) => Promise<Response | null>;

export function createHttpFetchHandler(deps: {
  metrics: { withHttpMetrics: (fn: () => Promise<Response>) => Promise<Response> };
  CORS_HEADERS: Record<string, string>;
  routes: RouteHandler[];
}) {
  return async function fetchHandler(req: Request, server: unknown): Promise<Response> {
    return deps.metrics.withHttpMetrics(async () => {
      if (req.method === "OPTIONS") {
        return new Response("", { headers: deps.CORS_HEADERS });
      }
      const url = new URL(req.url);
      const wrapped = wrapServerWithClientIp(server as RequestServerLike);
      for (const route of deps.routes) {
        const response = await route(req, url, wrapped);
        if (response) return response;
      }
      return new Response("Not found", { status: 404 });
    });
  };
}
