type MaybeResponse = Response | null;

type RouteHandler = (req: Request, url: URL) => Promise<MaybeResponse>;
type RouteHandlerWithServer<TServer> = (
  req: Request,
  url: URL,
  server: TServer,
) => Promise<MaybeResponse>;
type RouteHandlerWithServerDeps<TServer, TDeps> = (
  req: Request,
  url: URL,
  server: TServer,
  deps: TDeps,
) => Promise<MaybeResponse>;
type RouteHandlerWithDeps<TDeps> = (
  req: Request,
  url: URL,
  deps: TDeps,
) => Promise<MaybeResponse>;

type HttpDispatchDeps<
  TServer,
  TNotificationsConfig,
  TBuild,
  TDeploy,
  TAutoDeploy,
  TWinRE,
  TFileDownload,
  TPlugin,
  TFileShare,
  TMisc,
  TAssets,
  TPage,
  TClient,
  TWsUpgrade,
> = {
  metrics: { withHttpMetrics: (fn: () => Promise<Response>) => Promise<Response> };
  CORS_HEADERS: Record<string, string>;
  handleAuthRoutes: RouteHandlerWithServer<TServer>;
  handleNotificationsConfigRoutes: RouteHandlerWithServerDeps<TServer, TNotificationsConfig>;
  handleAutoScriptsRoutes: RouteHandler;
  handleAutoDeployRoutes: RouteHandlerWithDeps<TAutoDeploy>;
  handleEnrollmentRoutes: RouteHandler;
  handleChatRoutes: RouteHandler;
  handleSolRoutes: RouteHandler;
  handleUsersRoutes: RouteHandlerWithServer<TServer>;
  handleBuildRoutes: RouteHandlerWithServerDeps<TServer, TBuild>;
  handleDeployRoutes: RouteHandlerWithServerDeps<TServer, TDeploy>;
  handleWinRERoutes: RouteHandlerWithServerDeps<TServer, TWinRE>;
  handleFileDownloadRoutes: RouteHandlerWithServerDeps<TServer, TFileDownload>;
  handlePluginRoutes: RouteHandlerWithDeps<TPlugin>;
  handleFileShareRoutes: RouteHandlerWithDeps<TFileShare>;
  handleMiscRoutes: RouteHandlerWithDeps<TMisc>;
  handleAssetsRoutes: RouteHandlerWithDeps<TAssets>;
  handlePageRoutes: RouteHandlerWithDeps<TPage>;
  handleClientRoutes: RouteHandlerWithServerDeps<TServer, TClient>;
  handleWsUpgradeRoutes: RouteHandlerWithServerDeps<TServer, TWsUpgrade>;
  routeDeps: {
    notificationsConfig: TNotificationsConfig;
    build: TBuild;
    deploy: TDeploy;
    autoDeploy: TAutoDeploy;
    winre: TWinRE;
    fileDownload: TFileDownload;
    plugin: TPlugin;
    fileShare: TFileShare;
    misc: TMisc;
    assets: TAssets;
    page: TPage;
    client: TClient;
    wsUpgrade: TWsUpgrade;
  };
};

export function createHttpFetchHandler<
  TServer,
  TNotificationsConfig,
  TBuild,
  TDeploy,
  TAutoDeploy,
  TWinRE,
  TFileDownload,
  TPlugin,
  TFileShare,
  TMisc,
  TAssets,
  TPage,
  TClient,
  TWsUpgrade,
>(
  deps: HttpDispatchDeps<
    TServer,
    TNotificationsConfig,
    TBuild,
    TDeploy,
    TAutoDeploy,
    TWinRE,
    TFileDownload,
    TPlugin,
    TFileShare,
    TMisc,
    TAssets,
    TPage,
    TClient,
    TWsUpgrade
  >,
) {
  return async function fetchHandler(req: Request, server: unknown): Promise<Response> {
    return deps.metrics.withHttpMetrics(async () => {
      const routeServer = server as TServer;
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response("", { headers: deps.CORS_HEADERS });
      }

      const authRouteResponse = await deps.handleAuthRoutes(req, url, routeServer);
      if (authRouteResponse) return authRouteResponse;

      const notificationsConfigResponse = await deps.handleNotificationsConfigRoutes(req, url, routeServer, deps.routeDeps.notificationsConfig);
      if (notificationsConfigResponse) return notificationsConfigResponse;

      const autoScriptsResponse = await deps.handleAutoScriptsRoutes(req, url);
      if (autoScriptsResponse) return autoScriptsResponse;

      const autoDeployResponse = await deps.handleAutoDeployRoutes(req, url, deps.routeDeps.autoDeploy);
      if (autoDeployResponse) return autoDeployResponse;

      const enrollmentResponse = await deps.handleEnrollmentRoutes(req, url);
      if (enrollmentResponse) return enrollmentResponse;

      const chatResponse = await deps.handleChatRoutes(req, url);
      if (chatResponse) return chatResponse;

      const solResponse = await deps.handleSolRoutes(req, url);
      if (solResponse) return solResponse;

      const usersResponse = await deps.handleUsersRoutes(req, url, routeServer);
      if (usersResponse) return usersResponse;

      const buildResponse = await deps.handleBuildRoutes(req, url, routeServer, deps.routeDeps.build);
      if (buildResponse) return buildResponse;

      const deployResponse = await deps.handleDeployRoutes(req, url, routeServer, deps.routeDeps.deploy);
      if (deployResponse) return deployResponse;

      const winreResponse = await deps.handleWinRERoutes(req, url, routeServer, deps.routeDeps.winre);
      if (winreResponse) return winreResponse;

      const fileDownloadResponse = await deps.handleFileDownloadRoutes(req, url, routeServer, deps.routeDeps.fileDownload);
      if (fileDownloadResponse) return fileDownloadResponse;

      const pluginResponse = await deps.handlePluginRoutes(req, url, deps.routeDeps.plugin);
      if (pluginResponse) return pluginResponse;

      const fileShareResponse = await deps.handleFileShareRoutes(req, url, deps.routeDeps.fileShare);
      if (fileShareResponse) return fileShareResponse;

      const miscResponse = await deps.handleMiscRoutes(req, url, deps.routeDeps.misc);
      if (miscResponse) return miscResponse;

      const assetsResponse = await deps.handleAssetsRoutes(req, url, deps.routeDeps.assets);
      if (assetsResponse) return assetsResponse;

      const pageResponse = await deps.handlePageRoutes(req, url, deps.routeDeps.page);
      if (pageResponse) return pageResponse;

      const clientRouteResponse = await deps.handleClientRoutes(req, url, routeServer, deps.routeDeps.client);
      if (clientRouteResponse) return clientRouteResponse;

      const wsUpgradeResponse = await deps.handleWsUpgradeRoutes(req, url, routeServer, deps.routeDeps.wsUpgrade);
      if (wsUpgradeResponse) return wsUpgradeResponse;

      return new Response("Not found", { status: 404 });
    });
  };
}
