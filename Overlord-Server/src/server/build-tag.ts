import { recordBuildClaim } from "../db";
import { getUserById, setUserClientAccessRule, setUserClientAccessScope, getUserClientAccessScope } from "../users";
import { logger } from "../logger";

export function handleBuildTagConnection(
  clientId: string,
  buildId: string | null,
  builtByUserId: number | undefined,
  keyFingerprint: string,
): void {
  if (!buildId || !builtByUserId) return;

  const isFirstClaim = recordBuildClaim(buildId, keyFingerprint);
  if (!isFirstClaim) return;

  const user = getUserById(builtByUserId);
  if (!user) return;

  if (user.role === "admin") return;

  const currentScope = getUserClientAccessScope(builtByUserId);
  if (currentScope === "none") {
    setUserClientAccessScope(builtByUserId, "allowlist");
  }

  if (currentScope === "none" || currentScope === "allowlist") {
    setUserClientAccessRule(builtByUserId, clientId, "allow");
    logger.info(`[build-tag] Auto-added client ${clientId} to user ${user.username}'s allowlist (build: ${buildId.substring(0, 8)}, fp: ${keyFingerprint.substring(0, 12)}...)`);
  }
}
