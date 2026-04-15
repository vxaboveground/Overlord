import { existsSync, readFileSync, writeFileSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { dirname, resolve } from "path";
import logger from "./logger";
import { ensureDataDir } from "./paths";

export interface Config {
  auth: {
    username: string;
    password: string;
    jwtSecret: string;
    agentToken: string;
  };
  server: {
    port: number;
    host: string;
  };
  tls: {
    certPath: string;
    keyPath: string;
    caPath: string;
    certbot: {
      enabled: boolean;
      livePath: string;
      domain: string;
      certFileName: string;
      keyFileName: string;
      caFileName: string;
    };
  };
  notifications: {
    keywords: string[];
    minIntervalMs: number;
    spamWindowMs: number;
    spamWarnThreshold: number;
    historyLimit: number;
    webhookEnabled: boolean;
    webhookUrl: string;
    telegramEnabled: boolean;
    telegramBotToken: string;
    telegramChatId: string;
    clipboardEnabled: boolean;
  };
  security: {
    sessionTtlHours: number;
    loginMaxAttempts: number;
    loginWindowMinutes: number;
    loginLockoutMinutes: number;
    passwordMinLength: number;
    passwordRequireUppercase: boolean;
    passwordRequireLowercase: boolean;
    passwordRequireNumber: boolean;
    passwordRequireSymbol: boolean;
  };
  enrollment: {
    requireApproval: boolean;
  };
  appearance: {
    customCSS: string;
  };
  plugins: {
    trustedKeys: string[];
  };
  chat: {
    retentionDays: number;
  };
}

const DEFAULT_CONFIG: Config = {
  auth: {
    username: "admin",
    password: "admin",
    jwtSecret: "",
    agentToken: "",
  },
  server: {
    port: 5173,
    host: "0.0.0.0",
  },
  tls: {
    certPath: "./certs/server.crt",
    keyPath: "./certs/server.key",
    caPath: "",
    certbot: {
      enabled: false,
      livePath: "/etc/letsencrypt/live",
      domain: "",
      certFileName: "fullchain.pem",
      keyFileName: "privkey.pem",
      caFileName: "chain.pem",
    },
  },
  notifications: {
    keywords: ["bank", "password", "admin"],
    minIntervalMs: 8000,
    spamWindowMs: 60000,
    spamWarnThreshold: 5,
    historyLimit: 200,
    webhookEnabled: false,
    webhookUrl: "",
    telegramEnabled: false,
    telegramBotToken: "",
    telegramChatId: "",
    clipboardEnabled: false,
  },
  security: {
    sessionTtlHours: 168,
    loginMaxAttempts: 5,
    loginWindowMinutes: 15,
    loginLockoutMinutes: 30,
    passwordMinLength: 6,
    passwordRequireUppercase: false,
    passwordRequireLowercase: false,
    passwordRequireNumber: false,
    passwordRequireSymbol: false,
  },
  enrollment: {
    requireApproval: true,
  },
  appearance: {
    customCSS: "",
  },
  plugins: {
    trustedKeys: [],
  },
  chat: {
    retentionDays: 30,
  },
};

type SaveSecrets = {
  auth?: {
    jwtSecret?: string;
    agentToken?: string;
    bootstrapPassword?: string;
  };
};

function generateRandomSecret(length = 48): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let secret = "";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    secret += chars[array[i] % chars.length];
  }
  return secret;
}

function loadSaveSecrets(savePath: string): SaveSecrets {
  if (!existsSync(savePath)) {
    return {};
  }

  try {
    const raw = readFileSync(savePath, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch (error) {
    logger.warn("Failed to parse save.json, regenerating missing secrets:", error);
    return {};
  }
}

function persistSaveSecrets(savePath: string, secrets: SaveSecrets): void {
  try {
    writeFileSync(savePath, JSON.stringify(secrets, null, 2));
    logger.info(`Persisted secrets to ${savePath}`);
  } catch (error) {
    logger.warn("Failed to persist save.json secrets", error);
  }
}

let configCache: Config | null = null;

function getPersistentConfigPath(): string {
  return resolve(ensureDataDir(), "config.json");
}

function getLegacyConfigPath(): string {
  return resolve(process.cwd(), "config.json");
}

function tryReadConfigFile(path: string): any {
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    logger.warn(`Failed to parse config file at ${path}, using defaults:`, error);
    return {};
  }
}

function readFileConfigForLoad(): Partial<Config> {
  const persistentConfigPath = getPersistentConfigPath();
  if (existsSync(persistentConfigPath)) {
    logger.info(`Loaded configuration from ${persistentConfigPath}`);
    return tryReadConfigFile(persistentConfigPath);
  }

  const legacyConfigPath = getLegacyConfigPath();
  if (existsSync(legacyConfigPath)) {
    logger.info(`Loaded configuration from ${legacyConfigPath}`);
    return tryReadConfigFile(legacyConfigPath);
  }

  logger.info(
    "No config.json found, using defaults and environment variables",
  );
  return {};
}

function readFileConfigForUpdate(): any {
  const persistentConfigPath = getPersistentConfigPath();
  if (existsSync(persistentConfigPath)) {
    return tryReadConfigFile(persistentConfigPath);
  }

  const legacyConfigPath = getLegacyConfigPath();
  if (existsSync(legacyConfigPath)) {
    return tryReadConfigFile(legacyConfigPath);
  }

  return {};
}

async function writePersistentFileConfig(fileConfig: any): Promise<void> {
  const configPath = getPersistentConfigPath();

  try {
    await mkdir(dirname(configPath), { recursive: true });
  } catch {}

  await writeFile(configPath, JSON.stringify(fileConfig, null, 2));
}

export function loadConfig(): Config {
  if (configCache) {
    return configCache;
  }

  const fileConfig = readFileConfigForLoad();
  const dataDir = ensureDataDir();
  const savePath = resolve(dataDir, "save.json");
  const savedSecrets = loadSaveSecrets(savePath);
  let saveChanged = false;

  const jwtSecretFromEnv = process.env.JWT_SECRET;
  const jwtSecret =
    process.env.JWT_SECRET ||
    fileConfig.auth?.jwtSecret ||
    savedSecrets.auth?.jwtSecret ||
    DEFAULT_CONFIG.auth.jwtSecret;

  let finalJwtSecret = jwtSecret;
  if (!finalJwtSecret) {
    finalJwtSecret = generateRandomSecret(64);
    saveChanged = true;
    logger.info("No JWT secret provided, generated secure random secret");
  }

  const agentTokenFromEnv = process.env.OVERLORD_AGENT_TOKEN?.trim();
  const agentTokenFromConfig = fileConfig.auth?.agentToken?.trim();
  let finalAgentToken =
    agentTokenFromEnv ||
    agentTokenFromConfig ||
    savedSecrets.auth?.agentToken?.trim() ||
    DEFAULT_CONFIG.auth.agentToken;
  if (!finalAgentToken) {
    finalAgentToken = generateRandomSecret(64);
    saveChanged = true;
    logger.info("No agent token provided, generated secure random token");
  }

  const passwordFromEnv = process.env.OVERLORD_PASS;
  const passwordFromConfig = fileConfig.auth?.password;
  let finalBootstrapPassword =
    passwordFromEnv ||
    passwordFromConfig ||
    savedSecrets.auth?.bootstrapPassword ||
    DEFAULT_CONFIG.auth.password;

  const keywordsEnv = process.env.OVERLORD_NOTIFICATION_KEYWORDS;
  const keywordsFromEnv = keywordsEnv
    ? keywordsEnv
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
    : [];

  configCache = {
    auth: {
      username:
        process.env.OVERLORD_USER ||
        fileConfig.auth?.username ||
        DEFAULT_CONFIG.auth.username,
      password: finalBootstrapPassword,
      jwtSecret: finalJwtSecret,
      agentToken: finalAgentToken,
    },
    server: {
      port:
        Number(process.env.PORT) ||
        fileConfig.server?.port ||
        DEFAULT_CONFIG.server.port,
      host:
        process.env.HOST ||
        fileConfig.server?.host ||
        DEFAULT_CONFIG.server.host,
    },
    tls: {
      certPath:
        process.env.OVERLORD_TLS_CERT ||
        fileConfig.tls?.certPath ||
        DEFAULT_CONFIG.tls.certPath,
      keyPath:
        process.env.OVERLORD_TLS_KEY ||
        fileConfig.tls?.keyPath ||
        DEFAULT_CONFIG.tls.keyPath,
      caPath:
        process.env.OVERLORD_TLS_CA ||
        fileConfig.tls?.caPath ||
        DEFAULT_CONFIG.tls.caPath,
      certbot: {
        enabled:
          String(process.env.OVERLORD_TLS_CERTBOT_ENABLED || "").toLowerCase() === "true" ||
          fileConfig.tls?.certbot?.enabled ||
          DEFAULT_CONFIG.tls.certbot.enabled,
        livePath:
          process.env.OVERLORD_TLS_CERTBOT_LIVE_PATH ||
          fileConfig.tls?.certbot?.livePath ||
          DEFAULT_CONFIG.tls.certbot.livePath,
        domain:
          process.env.OVERLORD_TLS_CERTBOT_DOMAIN ||
          fileConfig.tls?.certbot?.domain ||
          DEFAULT_CONFIG.tls.certbot.domain,
        certFileName:
          process.env.OVERLORD_TLS_CERTBOT_CERT_FILE ||
          fileConfig.tls?.certbot?.certFileName ||
          DEFAULT_CONFIG.tls.certbot.certFileName,
        keyFileName:
          process.env.OVERLORD_TLS_CERTBOT_KEY_FILE ||
          fileConfig.tls?.certbot?.keyFileName ||
          DEFAULT_CONFIG.tls.certbot.keyFileName,
        caFileName:
          process.env.OVERLORD_TLS_CERTBOT_CA_FILE ||
          fileConfig.tls?.certbot?.caFileName ||
          DEFAULT_CONFIG.tls.certbot.caFileName,
      },
    },
    notifications: {
      keywords:
        keywordsFromEnv.length > 0
          ? keywordsFromEnv
          : (fileConfig.notifications?.keywords ||
              DEFAULT_CONFIG.notifications.keywords),
      minIntervalMs:
        Number(process.env.OVERLORD_NOTIFICATION_MIN_INTERVAL_MS) ||
        fileConfig.notifications?.minIntervalMs ||
        DEFAULT_CONFIG.notifications.minIntervalMs,
      spamWindowMs:
        Number(process.env.OVERLORD_NOTIFICATION_SPAM_WINDOW_MS) ||
        fileConfig.notifications?.spamWindowMs ||
        DEFAULT_CONFIG.notifications.spamWindowMs,
      spamWarnThreshold:
        Number(process.env.OVERLORD_NOTIFICATION_SPAM_WARN_THRESHOLD) ||
        fileConfig.notifications?.spamWarnThreshold ||
        DEFAULT_CONFIG.notifications.spamWarnThreshold,
      historyLimit:
        Number(process.env.OVERLORD_NOTIFICATION_HISTORY_LIMIT) ||
        fileConfig.notifications?.historyLimit ||
        DEFAULT_CONFIG.notifications.historyLimit,
      webhookEnabled:
        String(process.env.OVERLORD_NOTIFICATION_WEBHOOK_ENABLED || "").toLowerCase() === "true" ||
        fileConfig.notifications?.webhookEnabled ||
        DEFAULT_CONFIG.notifications.webhookEnabled,
      webhookUrl:
        process.env.OVERLORD_NOTIFICATION_WEBHOOK_URL ||
        fileConfig.notifications?.webhookUrl ||
        DEFAULT_CONFIG.notifications.webhookUrl,
      telegramEnabled:
        String(process.env.OVERLORD_NOTIFICATION_TELEGRAM_ENABLED || "").toLowerCase() === "true" ||
        fileConfig.notifications?.telegramEnabled ||
        DEFAULT_CONFIG.notifications.telegramEnabled,
      telegramBotToken:
        process.env.OVERLORD_NOTIFICATION_TELEGRAM_BOT_TOKEN ||
        fileConfig.notifications?.telegramBotToken ||
        DEFAULT_CONFIG.notifications.telegramBotToken,
      telegramChatId:
        process.env.OVERLORD_NOTIFICATION_TELEGRAM_CHAT_ID ||
        fileConfig.notifications?.telegramChatId ||
        DEFAULT_CONFIG.notifications.telegramChatId,
      clipboardEnabled:
        String(process.env.OVERLORD_NOTIFICATION_CLIPBOARD_ENABLED || "").toLowerCase() === "true" ||
        fileConfig.notifications?.clipboardEnabled ||
        DEFAULT_CONFIG.notifications.clipboardEnabled,
    },
    security: {
      sessionTtlHours:
        Number(process.env.OVERLORD_SESSION_TTL_HOURS) ||
        fileConfig.security?.sessionTtlHours ||
        DEFAULT_CONFIG.security.sessionTtlHours,
      loginMaxAttempts:
        Number(process.env.OVERLORD_LOGIN_MAX_ATTEMPTS) ||
        fileConfig.security?.loginMaxAttempts ||
        DEFAULT_CONFIG.security.loginMaxAttempts,
      loginWindowMinutes:
        Number(process.env.OVERLORD_LOGIN_WINDOW_MINUTES) ||
        fileConfig.security?.loginWindowMinutes ||
        DEFAULT_CONFIG.security.loginWindowMinutes,
      loginLockoutMinutes:
        Number(process.env.OVERLORD_LOGIN_LOCKOUT_MINUTES) ||
        fileConfig.security?.loginLockoutMinutes ||
        DEFAULT_CONFIG.security.loginLockoutMinutes,
      passwordMinLength:
        Number(process.env.OVERLORD_PASSWORD_MIN_LENGTH) ||
        fileConfig.security?.passwordMinLength ||
        DEFAULT_CONFIG.security.passwordMinLength,
      passwordRequireUppercase:
        String(process.env.OVERLORD_PASSWORD_REQUIRE_UPPERCASE || "").toLowerCase() === "true" ||
        fileConfig.security?.passwordRequireUppercase ||
        DEFAULT_CONFIG.security.passwordRequireUppercase,
      passwordRequireLowercase:
        String(process.env.OVERLORD_PASSWORD_REQUIRE_LOWERCASE || "").toLowerCase() === "true" ||
        fileConfig.security?.passwordRequireLowercase ||
        DEFAULT_CONFIG.security.passwordRequireLowercase,
      passwordRequireNumber:
        String(process.env.OVERLORD_PASSWORD_REQUIRE_NUMBER || "").toLowerCase() === "true" ||
        fileConfig.security?.passwordRequireNumber ||
        DEFAULT_CONFIG.security.passwordRequireNumber,
      passwordRequireSymbol:
        String(process.env.OVERLORD_PASSWORD_REQUIRE_SYMBOL || "").toLowerCase() === "true" ||
        fileConfig.security?.passwordRequireSymbol ||
        DEFAULT_CONFIG.security.passwordRequireSymbol,
    },
    enrollment: {
      requireApproval:
        process.env.OVERLORD_ENROLLMENT_REQUIRE_APPROVAL !== undefined
          ? String(process.env.OVERLORD_ENROLLMENT_REQUIRE_APPROVAL).toLowerCase() === "true"
          : (fileConfig.enrollment?.requireApproval ?? DEFAULT_CONFIG.enrollment.requireApproval),
    },
    appearance: {
      customCSS: fileConfig.appearance?.customCSS || DEFAULT_CONFIG.appearance.customCSS,
    },
    plugins: {
      trustedKeys: (() => {
        const envKeys = process.env.TRUSTED_PLUGIN_KEYS;
        if (envKeys) {
          return envKeys.split(",").map((k) => k.trim()).filter(Boolean);
        }
        return fileConfig.plugins?.trustedKeys || DEFAULT_CONFIG.plugins.trustedKeys;
      })(),
    },
    chat: {
      retentionDays:
        Number(process.env.OVERLORD_CHAT_RETENTION_DAYS) ||
        fileConfig.chat?.retentionDays ||
        DEFAULT_CONFIG.chat.retentionDays,
    },
  };

  if (saveChanged) {
    const nextSecrets: SaveSecrets = {
      auth: {
        jwtSecret: finalJwtSecret,
        agentToken: finalAgentToken,
        bootstrapPassword: finalBootstrapPassword,
      },
    };
    persistSaveSecrets(savePath, nextSecrets);
    logger.info(
      `Generated runtime secrets are stored at ${savePath}. Keep this file private.`,
    );
  }

  if (jwtSecretFromEnv) {
    logger.info("JWT secret loaded from JWT_SECRET environment variable");
  }
  if (agentTokenFromEnv) {
    logger.info("Agent token loaded from OVERLORD_AGENT_TOKEN environment variable");
  }
  if (passwordFromEnv) {
    logger.info("Initial admin password loaded from OVERLORD_PASS environment variable");
  }

  return configCache;
}

export function getConfig(): Config {
  if (!configCache) {
    return loadConfig();
  }
  return configCache;
}

export async function updateNotificationsConfig(
  updates: Partial<Config["notifications"]>,
): Promise<Config["notifications"]> {
  const current = getConfig();
  const keywords = (updates.keywords || current.notifications.keywords || [])
    .map((k) => String(k).trim())
    .filter(Boolean);
  const deduped = Array.from(new Set(keywords));

  const next = {
    ...current.notifications,
    ...updates,
    keywords: deduped,
  };

  configCache = {
    ...current,
    notifications: next,
  };

  const fileConfig = readFileConfigForUpdate();

  fileConfig.notifications = next;

  await writePersistentFileConfig(fileConfig);
  return next;
}

export async function updateSecurityConfig(
  updates: Partial<Config["security"]>,
): Promise<Config["security"]> {
  const current = getConfig();

  const next = {
    ...current.security,
    ...updates,
  };

  const toNumberOr = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  next.sessionTtlHours = Math.min(24 * 30, Math.max(1, toNumberOr(next.sessionTtlHours, 168)));
  next.loginMaxAttempts = Math.min(50, Math.max(1, toNumberOr(next.loginMaxAttempts, 5)));
  next.loginWindowMinutes = Math.min(24 * 24, Math.max(1, toNumberOr(next.loginWindowMinutes, 15)));
  next.loginLockoutMinutes = Math.min(24 * 24, Math.max(1, toNumberOr(next.loginLockoutMinutes, 30)));
  next.passwordMinLength = Math.min(128, Math.max(6, toNumberOr(next.passwordMinLength, 6)));
  next.passwordRequireUppercase = Boolean(next.passwordRequireUppercase);
  next.passwordRequireLowercase = Boolean(next.passwordRequireLowercase);
  next.passwordRequireNumber = Boolean(next.passwordRequireNumber);
  next.passwordRequireSymbol = Boolean(next.passwordRequireSymbol);

  configCache = {
    ...current,
    security: next,
  };

  const fileConfig = readFileConfigForUpdate();

  fileConfig.security = next;

  await writePersistentFileConfig(fileConfig);
  return next;
}

export async function updateEnrollmentConfig(
  updates: Partial<Config["enrollment"]>,
): Promise<Config["enrollment"]> {
  const current = getConfig();
  const next = {
    ...current.enrollment,
    ...updates,
    requireApproval: updates.requireApproval !== undefined ? Boolean(updates.requireApproval) : current.enrollment.requireApproval,
  };

  configCache = {
    ...current,
    enrollment: next,
  };

  const fileConfig = readFileConfigForUpdate();
  fileConfig.enrollment = next;
  await writePersistentFileConfig(fileConfig);
  return next;
}

export async function updateTlsConfig(
  updates: Partial<Config["tls"]>,
): Promise<Config["tls"]> {
  const current = getConfig();

  const next = {
    ...current.tls,
    ...updates,
    certbot: {
      ...current.tls.certbot,
      ...(updates.certbot || {}),
    },
  };

  next.certPath = String(next.certPath || DEFAULT_CONFIG.tls.certPath).trim() || DEFAULT_CONFIG.tls.certPath;
  next.keyPath = String(next.keyPath || DEFAULT_CONFIG.tls.keyPath).trim() || DEFAULT_CONFIG.tls.keyPath;
  next.caPath = String(next.caPath || "").trim();

  next.certbot.enabled = Boolean(next.certbot.enabled);
  next.certbot.livePath =
    String(next.certbot.livePath || DEFAULT_CONFIG.tls.certbot.livePath).trim() ||
    DEFAULT_CONFIG.tls.certbot.livePath;
  next.certbot.domain = String(next.certbot.domain || "").trim();
  next.certbot.certFileName =
    String(next.certbot.certFileName || DEFAULT_CONFIG.tls.certbot.certFileName).trim() ||
    DEFAULT_CONFIG.tls.certbot.certFileName;
  next.certbot.keyFileName =
    String(next.certbot.keyFileName || DEFAULT_CONFIG.tls.certbot.keyFileName).trim() ||
    DEFAULT_CONFIG.tls.certbot.keyFileName;
  next.certbot.caFileName =
    String(next.certbot.caFileName || DEFAULT_CONFIG.tls.certbot.caFileName).trim() ||
    DEFAULT_CONFIG.tls.certbot.caFileName;

  configCache = {
    ...current,
    tls: next,
  };

  const fileConfig = readFileConfigForUpdate();

  fileConfig.tls = next;

  await writePersistentFileConfig(fileConfig);
  return next;
}

export async function updateAppearanceConfig(customCSS: string): Promise<Config["appearance"]> {
  const current = getConfig();
  const next = { customCSS: String(customCSS || "").slice(0, 51200) };

  configCache = {
    ...current,
    appearance: next,
  };

  const fileConfig = readFileConfigForUpdate();
  fileConfig.appearance = next;
  await writePersistentFileConfig(fileConfig);
  return next;
}

export async function updatePluginsConfig(
  updates: Partial<Config["plugins"]>,
): Promise<Config["plugins"]> {
  const current = getConfig();
  const trustedKeys = (updates.trustedKeys || current.plugins.trustedKeys || [])
    .map((k) => String(k).trim().toLowerCase())
    .filter(Boolean);
  const deduped = Array.from(new Set(trustedKeys));

  const next: Config["plugins"] = {
    ...current.plugins,
    trustedKeys: deduped,
  };

  configCache = {
    ...current,
    plugins: next,
  };

  const fileConfig = readFileConfigForUpdate();
  fileConfig.plugins = next;
  await writePersistentFileConfig(fileConfig);
  return next;
}

export async function updateChatConfig(
  updates: Partial<Config["chat"]>,
): Promise<Config["chat"]> {
  const current = getConfig();

  const toNumberOr = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const next: Config["chat"] = {
    ...current.chat,
    ...updates,
  };

  const raw = toNumberOr(next.retentionDays, 30);
  next.retentionDays = raw === 0 ? 0 : Math.min(365, Math.max(1, raw));

  configCache = {
    ...current,
    chat: next,
  };

  const fileConfig = readFileConfigForUpdate();
  fileConfig.chat = next;
  await writePersistentFileConfig(fileConfig);
  return next;
}

export function getExportableConfig(serverVersion: string): Record<string, unknown> {
  const config = getConfig();
  return {
    _meta: {
      exportedAt: new Date().toISOString(),
      version: serverVersion,
    },
    auth: {
      jwtSecret: config.auth.jwtSecret,
      agentToken: config.auth.agentToken,
    },
    notifications: config.notifications,
    security: config.security,
    tls: config.tls,
    enrollment: config.enrollment,
    appearance: config.appearance,
    plugins: config.plugins,
    chat: config.chat,
  };
}

export async function importFullConfig(data: Record<string, any>): Promise<{ applied: string[]; warnings: string[] }> {
  const applied: string[] = [];
  const warnings: string[] = [];

  const envOverrides: Record<string, string | undefined> = {
    notifications: process.env.OVERLORD_NOTIFICATION_KEYWORDS || process.env.OVERLORD_NOTIFICATION_WEBHOOK_URL,
    security: process.env.OVERLORD_SESSION_TTL_HOURS || process.env.OVERLORD_LOGIN_MAX_ATTEMPTS,
    tls: process.env.OVERLORD_TLS_CERT || process.env.OVERLORD_TLS_CERTBOT_ENABLED,
    auth: process.env.JWT_SECRET || process.env.OVERLORD_AGENT_TOKEN,
  };

  if (data.notifications && typeof data.notifications === "object") {
    await updateNotificationsConfig(data.notifications);
    applied.push("notifications");
    if (envOverrides.notifications) {
      warnings.push("Some notification settings may be overridden by environment variables after restart.");
    }
  }

  if (data.security && typeof data.security === "object") {
    await updateSecurityConfig(data.security);
    applied.push("security");
    if (envOverrides.security) {
      warnings.push("Some security settings may be overridden by environment variables after restart.");
    }
  }

  if (data.tls && typeof data.tls === "object") {
    await updateTlsConfig(data.tls);
    applied.push("tls");
    if (envOverrides.tls) {
      warnings.push("Some TLS settings may be overridden by environment variables after restart.");
    }
  }

  if (data.enrollment && typeof data.enrollment === "object") {
    await updateEnrollmentConfig(data.enrollment);
    applied.push("enrollment");
  }

  if (data.appearance && typeof data.appearance === "object") {
    const css = typeof data.appearance.customCSS === "string" ? data.appearance.customCSS : "";
    if (css.length <= 51200) {
      await updateAppearanceConfig(css);
      applied.push("appearance");
    } else {
      warnings.push("Custom CSS exceeds 50 KB limit and was skipped.");
    }
  }

  if (data.plugins && typeof data.plugins === "object") {
    await updatePluginsConfig(data.plugins);
    applied.push("plugins");
  }

  if (data.chat && typeof data.chat === "object") {
    await updateChatConfig(data.chat);
    applied.push("chat");
  }

  if (data.auth && typeof data.auth === "object") {
    const dataDir = ensureDataDir();
    const savePath = resolve(dataDir, "save.json");
    const savedSecrets = loadSaveSecrets(savePath);
    let changed = false;

    if (typeof data.auth.jwtSecret === "string" && data.auth.jwtSecret) {
      if (!savedSecrets.auth) savedSecrets.auth = {};
      savedSecrets.auth.jwtSecret = data.auth.jwtSecret;
      changed = true;
    }

    if (typeof data.auth.agentToken === "string" && data.auth.agentToken) {
      if (!savedSecrets.auth) savedSecrets.auth = {};
      savedSecrets.auth.agentToken = data.auth.agentToken;
      changed = true;
    }

    if (changed) {
      persistSaveSecrets(savePath, savedSecrets);
      applied.push("auth (secrets updated in save.json — restart required)");
      if (envOverrides.auth) {
        warnings.push("Auth secrets may be overridden by JWT_SECRET / OVERLORD_AGENT_TOKEN environment variables.");
      }
    }
  }

  return { applied, warnings };
}
