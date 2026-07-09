import { existsSync, readFileSync, writeFileSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { dirname, resolve } from "path";
import logger from "./logger";
import { ensureDataDir } from "./paths";

export interface Config {
  auth: {
    username: string;
    password: string;
    passwordIsUserSupplied: boolean;
    jwtSecret: string;
    agentToken: string;
  };
  oidc: {
    enabled: boolean;
    label: string;
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scopes: string[];
    clientAuthMethod: "client_secret_post" | "client_secret_basic" | "none";
    autoProvision: boolean;
    allowEmailLink: boolean;
    defaultRole: "admin" | "operator" | "viewer";
    allowedEmails: string[];
    allowedDomains: string[];
    groupClaim: string;
    adminGroups: string[];
    operatorGroups: string[];
    viewerGroups: string[];
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
    antiSpamMaxHits: number;
    antiSpamWindowMs: number;
    antiSpamCooldownMs: number;
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
    mfaRequiredForAdmins: boolean;
    mfaRequiredForNonAdmins: boolean;
  };
  enrollment: {
    requireApproval: boolean;
    autoApproveUnlessSuspicious: boolean;
  };
  appearance: {
    customCSS: string;
    loginBranding: {
      productName: string;
      navName: string;
      title: string;
      subtitle: string;
      iconClass: string;
      logoUrl: string;
      logoAlt: string;
      navLogoUrl: string;
      navLogoAlt: string;
      heroImageUrl: string;
      heroImageAlt: string;
      accentColor: string;
      footerText: string;
      supportText: string;
      supportUrl: string;
    };
  };
  plugins: {
    trustedKeys: string[];
  };
  chat: {
    retentionDays: number;
  };
  registration: {
    mode: "off" | "open" | "key" | "approval";
    defaultRole: "operator" | "viewer";
    maxUsersTotal: number;
    defaultGroupIds: number[];
  };
  buildRateLimit: {
    maxBuildsPerHour: number;
    maxConcurrentPerUser: number;
    globalMaxConcurrent: number;
  };
  buildSigning: {
    banlist: string[];
  };
  thumbnails: {
    dashboardEnabled: boolean;
    wallEnabled: boolean;
  };
  inputArchive: {
    enabled: boolean;
    retentionDays: number;
    maxFileBytes: number;
    pollIntervalSeconds: number;
  };
}

const DEFAULT_CONFIG: Config = {
  auth: {
    username: "admin",
    password: "admin",
    passwordIsUserSupplied: false,
    jwtSecret: "",
    agentToken: "",
  },
  oidc: {
    enabled: false,
    label: "Single sign-on",
    issuer: "",
    clientId: "",
    clientSecret: "",
    redirectUri: "",
    scopes: ["openid", "profile", "email"],
    clientAuthMethod: "client_secret_post",
    autoProvision: true,
    allowEmailLink: false,
    defaultRole: "viewer",
    allowedEmails: [],
    allowedDomains: [],
    groupClaim: "groups",
    adminGroups: [],
    operatorGroups: [],
    viewerGroups: [],
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
    antiSpamMaxHits: 15,
    antiSpamWindowMs: 600000,
    antiSpamCooldownMs: 600000,
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
    mfaRequiredForAdmins: false,
    mfaRequiredForNonAdmins: false,
  },
  enrollment: {
    requireApproval: true,
    autoApproveUnlessSuspicious: false,
  },
  appearance: {
    customCSS: "",
    loginBranding: {
      productName: "Overlord",
      navName: "Overlord",
      title: "Welcome back",
      subtitle: "Sign in to your control plane",
      iconClass: "fa-solid fa-crown",
      logoUrl: "",
      logoAlt: "Overlord logo",
      navLogoUrl: "",
      navLogoAlt: "Overlord logo",
      heroImageUrl: "",
      heroImageAlt: "Overlord sign-in background",
      accentColor: "#7a5bff",
      footerText: "",
      supportText: "",
      supportUrl: "",
    },
  },
  plugins: {
    trustedKeys: [],
  },
  chat: {
    retentionDays: 30,
  },
  registration: {
    mode: "off" as const,
    defaultRole: "operator" as const,
    maxUsersTotal: 0,
    defaultGroupIds: [] as number[],
  },
  buildRateLimit: {
    maxBuildsPerHour: 5,
    maxConcurrentPerUser: 1,
    globalMaxConcurrent: 3,
  },
  buildSigning: {
    banlist: [],
  },
  thumbnails: {
    dashboardEnabled: true,
    wallEnabled: true,
  },
  inputArchive: {
    enabled: false,
    retentionDays: 7,
    maxFileBytes: 5 * 1024 * 1024,
    pollIntervalSeconds: 300,
  },
};

function envBoolOverride(name: string): boolean | undefined {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return undefined;
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

function pickRole(value: unknown, fallback: Config["oidc"]["defaultRole"]): Config["oidc"]["defaultRole"] {
  return value === "admin" || value === "operator" || value === "viewer"
    ? value
    : fallback;
}

function pickClientAuthMethod(value: unknown): Config["oidc"]["clientAuthMethod"] {
  return value === "client_secret_basic" || value === "none"
    ? value
    : "client_secret_post";
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  const raw = typeof value === "string" ? value : "";
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).slice(0, maxLength);
}

function cleanIconClass(value: unknown, fallback: string): string {
  const raw = cleanText(value, fallback, 120);
  const cleaned = raw.replace(/[^A-Za-z0-9_:\-\s]/g, "").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function cleanLogoUrl(value: unknown): string {
  const raw = cleanText(value, "", 2048);
  if (!raw) return "";
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
  } catch {}

  return "";
}

function cleanBrandColor(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : fallback;
}

function cleanLoginBranding(
  value: Partial<Config["appearance"]["loginBranding"]> | undefined,
  fallback: Config["appearance"]["loginBranding"],
): Config["appearance"]["loginBranding"] {
  const productName = cleanText(value?.productName, fallback.productName, 80);
  const navName = cleanText(value?.navName, productName, 80);
  return {
    productName,
    navName,
    title: cleanText(value?.title, fallback.title, 120),
    subtitle: cleanText(value?.subtitle, fallback.subtitle, 180),
    iconClass: cleanIconClass(value?.iconClass, fallback.iconClass),
    logoUrl: cleanLogoUrl(value?.logoUrl),
    logoAlt: cleanText(value?.logoAlt, `${productName} logo`, 120),
    navLogoUrl: cleanLogoUrl(value?.navLogoUrl),
    navLogoAlt: cleanText(value?.navLogoAlt, `${navName} logo`, 120),
    heroImageUrl: cleanLogoUrl(value?.heroImageUrl),
    heroImageAlt: cleanText(value?.heroImageAlt, `${productName} sign-in image`, 160),
    accentColor: cleanBrandColor(value?.accentColor, fallback.accentColor),
    footerText: cleanText(value?.footerText, "", 160),
    supportText: cleanText(value?.supportText, "", 120),
    supportUrl: cleanLogoUrl(value?.supportUrl),
  };
}

type SaveSecrets = {
  auth?: {
    jwtSecret?: string;
    agentToken?: string;
    bootstrapPassword?: string;
  };
  buildSigning?: {
    privateKey?: string;
    publicKey?: string;
  };
  clientLogs?: {
    privateKey?: string;
    publicKey?: string;
  };
};

export type BuildSigningSecrets = {
  privateKey: string;
  publicKey: string;
};

export type ClientLogSecrets = {
  privateKey: string;
  publicKey: string;
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
  const passwordFromSaved = savedSecrets.auth?.bootstrapPassword;
  let finalBootstrapPassword =
    passwordFromEnv ||
    passwordFromConfig ||
    passwordFromSaved ||
    DEFAULT_CONFIG.auth.password;
  const passwordIsUserSupplied =
    Boolean(passwordFromEnv) ||
    Boolean(passwordFromConfig);

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
      passwordIsUserSupplied,
      jwtSecret: finalJwtSecret,
      agentToken: finalAgentToken,
    },
    oidc: {
      enabled:
        envBoolOverride("OVERLORD_OIDC_ENABLED") ??
        (fileConfig.oidc?.enabled !== undefined
          ? Boolean(fileConfig.oidc.enabled)
          : DEFAULT_CONFIG.oidc.enabled),
      label:
        process.env.OVERLORD_OIDC_LABEL ||
        fileConfig.oidc?.label ||
        DEFAULT_CONFIG.oidc.label,
      issuer:
        process.env.OVERLORD_OIDC_ISSUER ||
        fileConfig.oidc?.issuer ||
        DEFAULT_CONFIG.oidc.issuer,
      clientId:
        process.env.OVERLORD_OIDC_CLIENT_ID ||
        fileConfig.oidc?.clientId ||
        DEFAULT_CONFIG.oidc.clientId,
      clientSecret:
        process.env.OVERLORD_OIDC_CLIENT_SECRET ||
        fileConfig.oidc?.clientSecret ||
        DEFAULT_CONFIG.oidc.clientSecret,
      redirectUri:
        process.env.OVERLORD_OIDC_REDIRECT_URI ||
        fileConfig.oidc?.redirectUri ||
        DEFAULT_CONFIG.oidc.redirectUri,
      scopes: (() => {
        const envScopes = splitList(process.env.OVERLORD_OIDC_SCOPES);
        if (envScopes.length > 0) return envScopes;
        const fileScopes = splitList(fileConfig.oidc?.scopes);
        return fileScopes.length > 0 ? fileScopes : [...DEFAULT_CONFIG.oidc.scopes];
      })(),
      clientAuthMethod: pickClientAuthMethod(
        process.env.OVERLORD_OIDC_CLIENT_AUTH_METHOD ||
        fileConfig.oidc?.clientAuthMethod,
      ),
      autoProvision:
        envBoolOverride("OVERLORD_OIDC_AUTO_PROVISION") ??
        (fileConfig.oidc?.autoProvision !== undefined
          ? Boolean(fileConfig.oidc.autoProvision)
          : DEFAULT_CONFIG.oidc.autoProvision),
      allowEmailLink:
        envBoolOverride("OVERLORD_OIDC_ALLOW_EMAIL_LINK") ??
        (fileConfig.oidc?.allowEmailLink !== undefined
          ? Boolean(fileConfig.oidc.allowEmailLink)
          : DEFAULT_CONFIG.oidc.allowEmailLink),
      defaultRole: pickRole(
        process.env.OVERLORD_OIDC_DEFAULT_ROLE ||
        fileConfig.oidc?.defaultRole,
        DEFAULT_CONFIG.oidc.defaultRole,
      ),
      allowedEmails: (() => {
        const envEmails = splitList(process.env.OVERLORD_OIDC_ALLOWED_EMAILS);
        return envEmails.length > 0 ? envEmails : splitList(fileConfig.oidc?.allowedEmails);
      })(),
      allowedDomains: (() => {
        const envDomains = splitList(process.env.OVERLORD_OIDC_ALLOWED_DOMAINS);
        return envDomains.length > 0 ? envDomains : splitList(fileConfig.oidc?.allowedDomains);
      })(),
      groupClaim:
        process.env.OVERLORD_OIDC_GROUP_CLAIM ||
        fileConfig.oidc?.groupClaim ||
        DEFAULT_CONFIG.oidc.groupClaim,
      adminGroups: (() => {
        const envGroups = splitList(process.env.OVERLORD_OIDC_ADMIN_GROUPS);
        return envGroups.length > 0 ? envGroups : splitList(fileConfig.oidc?.adminGroups);
      })(),
      operatorGroups: (() => {
        const envGroups = splitList(process.env.OVERLORD_OIDC_OPERATOR_GROUPS);
        return envGroups.length > 0 ? envGroups : splitList(fileConfig.oidc?.operatorGroups);
      })(),
      viewerGroups: (() => {
        const envGroups = splitList(process.env.OVERLORD_OIDC_VIEWER_GROUPS);
        return envGroups.length > 0 ? envGroups : splitList(fileConfig.oidc?.viewerGroups);
      })(),
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
      antiSpamMaxHits:
        Number(process.env.OVERLORD_NOTIFICATION_ANTISPAM_MAX_HITS) ||
        fileConfig.notifications?.antiSpamMaxHits ||
        DEFAULT_CONFIG.notifications.antiSpamMaxHits,
      antiSpamWindowMs:
        Number(process.env.OVERLORD_NOTIFICATION_ANTISPAM_WINDOW_MS) ||
        fileConfig.notifications?.antiSpamWindowMs ||
        DEFAULT_CONFIG.notifications.antiSpamWindowMs,
      antiSpamCooldownMs:
        Number(process.env.OVERLORD_NOTIFICATION_ANTISPAM_COOLDOWN_MS) ||
        fileConfig.notifications?.antiSpamCooldownMs ||
        DEFAULT_CONFIG.notifications.antiSpamCooldownMs,
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
      mfaRequiredForAdmins:
        String(process.env.OVERLORD_MFA_REQUIRED_FOR_ADMINS || "").toLowerCase() === "true" ||
        fileConfig.security?.mfaRequiredForAdmins ||
        DEFAULT_CONFIG.security.mfaRequiredForAdmins,
      mfaRequiredForNonAdmins:
        String(process.env.OVERLORD_MFA_REQUIRED_FOR_NON_ADMINS || "").toLowerCase() === "true" ||
        fileConfig.security?.mfaRequiredForNonAdmins ||
        DEFAULT_CONFIG.security.mfaRequiredForNonAdmins,
    },
    enrollment: {
      requireApproval:
        process.env.OVERLORD_ENROLLMENT_REQUIRE_APPROVAL !== undefined
          ? String(process.env.OVERLORD_ENROLLMENT_REQUIRE_APPROVAL).toLowerCase() === "true"
          : (fileConfig.enrollment?.requireApproval ?? DEFAULT_CONFIG.enrollment.requireApproval),
      autoApproveUnlessSuspicious:
        fileConfig.enrollment?.autoApproveUnlessSuspicious ?? DEFAULT_CONFIG.enrollment.autoApproveUnlessSuspicious,
    },
    appearance: {
      customCSS: fileConfig.appearance?.customCSS || DEFAULT_CONFIG.appearance.customCSS,
      loginBranding: cleanLoginBranding(
        {
          ...(fileConfig.appearance?.loginBranding || {}),
          productName:
            process.env.OVERLORD_LOGIN_BRAND_NAME ||
            process.env.OVERLORD_BRAND_NAME ||
            fileConfig.appearance?.loginBranding?.productName,
          navName:
            process.env.OVERLORD_NAV_BRAND_NAME ||
            process.env.OVERLORD_BRAND_NAME ||
            fileConfig.appearance?.loginBranding?.navName,
          title:
            process.env.OVERLORD_LOGIN_TITLE ||
            fileConfig.appearance?.loginBranding?.title,
          subtitle:
            process.env.OVERLORD_LOGIN_SUBTITLE ||
            fileConfig.appearance?.loginBranding?.subtitle,
          iconClass:
            process.env.OVERLORD_LOGIN_ICON_CLASS ||
            fileConfig.appearance?.loginBranding?.iconClass,
          logoUrl:
            process.env.OVERLORD_LOGIN_LOGO_URL ||
            fileConfig.appearance?.loginBranding?.logoUrl,
          logoAlt:
            process.env.OVERLORD_LOGIN_LOGO_ALT ||
            fileConfig.appearance?.loginBranding?.logoAlt,
          navLogoUrl:
            process.env.OVERLORD_NAV_LOGO_URL ||
            process.env.OVERLORD_BRAND_LOGO_URL ||
            fileConfig.appearance?.loginBranding?.navLogoUrl,
          navLogoAlt:
            process.env.OVERLORD_NAV_LOGO_ALT ||
            process.env.OVERLORD_BRAND_LOGO_ALT ||
            fileConfig.appearance?.loginBranding?.navLogoAlt,
          heroImageUrl:
            process.env.OVERLORD_LOGIN_HERO_IMAGE_URL ||
            fileConfig.appearance?.loginBranding?.heroImageUrl,
          heroImageAlt:
            process.env.OVERLORD_LOGIN_HERO_IMAGE_ALT ||
            fileConfig.appearance?.loginBranding?.heroImageAlt,
          accentColor:
            process.env.OVERLORD_BRAND_ACCENT_COLOR ||
            fileConfig.appearance?.loginBranding?.accentColor,
          footerText:
            process.env.OVERLORD_LOGIN_FOOTER_TEXT ||
            fileConfig.appearance?.loginBranding?.footerText,
          supportText:
            process.env.OVERLORD_LOGIN_SUPPORT_TEXT ||
            fileConfig.appearance?.loginBranding?.supportText,
          supportUrl:
            process.env.OVERLORD_LOGIN_SUPPORT_URL ||
            fileConfig.appearance?.loginBranding?.supportUrl,
        },
        DEFAULT_CONFIG.appearance.loginBranding,
      ),
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
    registration: {
      mode: (() => {
        const envMode = process.env.OVERLORD_REGISTRATION_MODE;
        if (envMode && ["off", "open", "key", "approval"].includes(envMode)) return envMode as Config["registration"]["mode"];
        const fileMode = fileConfig.registration?.mode;
        if (fileMode && ["off", "open", "key", "approval"].includes(fileMode)) return fileMode as Config["registration"]["mode"];
        return DEFAULT_CONFIG.registration.mode;
      })(),
      defaultRole: (() => {
        const envRole = process.env.OVERLORD_REGISTRATION_DEFAULT_ROLE;
        if (envRole && ["operator", "viewer"].includes(envRole)) return envRole as Config["registration"]["defaultRole"];
        const fileRole = fileConfig.registration?.defaultRole;
        if (fileRole && ["operator", "viewer"].includes(fileRole)) return fileRole as Config["registration"]["defaultRole"];
        return DEFAULT_CONFIG.registration.defaultRole;
      })(),
      maxUsersTotal:
        Number(process.env.OVERLORD_REGISTRATION_MAX_USERS) ||
        fileConfig.registration?.maxUsersTotal ||
        DEFAULT_CONFIG.registration.maxUsersTotal,
      defaultGroupIds: Array.isArray(fileConfig.registration?.defaultGroupIds)
        ? fileConfig.registration.defaultGroupIds
            .map((g: unknown) => Number(g))
            .filter((g: number) => Number.isFinite(g) && g > 0)
        : [...DEFAULT_CONFIG.registration.defaultGroupIds],
    },
    buildRateLimit: {
      maxBuildsPerHour:
        Number(process.env.OVERLORD_BUILD_MAX_PER_HOUR) ||
        fileConfig.buildRateLimit?.maxBuildsPerHour ||
        DEFAULT_CONFIG.buildRateLimit.maxBuildsPerHour,
      maxConcurrentPerUser:
        Number(process.env.OVERLORD_BUILD_MAX_CONCURRENT_USER) ||
        fileConfig.buildRateLimit?.maxConcurrentPerUser ||
        DEFAULT_CONFIG.buildRateLimit.maxConcurrentPerUser,
      globalMaxConcurrent:
        Number(process.env.OVERLORD_BUILD_MAX_CONCURRENT_GLOBAL) ||
        fileConfig.buildRateLimit?.globalMaxConcurrent ||
        DEFAULT_CONFIG.buildRateLimit.globalMaxConcurrent,
    },
    buildSigning: {
      banlist: Array.isArray(fileConfig.buildSigning?.banlist)
        ? fileConfig.buildSigning.banlist.filter((v: unknown): v is string => typeof v === "string" && v.length > 0)
        : [...DEFAULT_CONFIG.buildSigning.banlist],
    },
    thumbnails: {
      dashboardEnabled:
        envBoolOverride("OVERLORD_THUMBNAILS_DASHBOARD_ENABLED") ??
        (fileConfig.thumbnails?.dashboardEnabled !== undefined
          ? Boolean(fileConfig.thumbnails.dashboardEnabled)
          : DEFAULT_CONFIG.thumbnails.dashboardEnabled),
      wallEnabled:
        envBoolOverride("OVERLORD_THUMBNAILS_WALL_ENABLED") ??
        (fileConfig.thumbnails?.wallEnabled !== undefined
          ? Boolean(fileConfig.thumbnails.wallEnabled)
          : DEFAULT_CONFIG.thumbnails.wallEnabled),
    },
    inputArchive: {
      enabled:
        envBoolOverride("OVERLORD_INPUT_ARCHIVE_ENABLED") ??
        (fileConfig.inputArchive?.enabled !== undefined
          ? Boolean(fileConfig.inputArchive.enabled)
          : DEFAULT_CONFIG.inputArchive.enabled),
      retentionDays: Math.min(
        365,
        Math.max(1, Number(process.env.OVERLORD_INPUT_ARCHIVE_RETENTION_DAYS) || Number(fileConfig.inputArchive?.retentionDays) || DEFAULT_CONFIG.inputArchive.retentionDays),
      ),
      maxFileBytes: Math.min(
        50 * 1024 * 1024,
        Math.max(64 * 1024, Number(process.env.OVERLORD_INPUT_ARCHIVE_MAX_FILE_BYTES) || Number(fileConfig.inputArchive?.maxFileBytes) || DEFAULT_CONFIG.inputArchive.maxFileBytes),
      ),
      pollIntervalSeconds: Math.min(
        24 * 60 * 60,
        Math.max(
          0,
          process.env.OVERLORD_INPUT_ARCHIVE_POLL_INTERVAL_SECONDS !== undefined
            ? Number(process.env.OVERLORD_INPUT_ARCHIVE_POLL_INTERVAL_SECONDS)
            : fileConfig.inputArchive?.pollIntervalSeconds !== undefined
              ? Number(fileConfig.inputArchive.pollIntervalSeconds)
              : DEFAULT_CONFIG.inputArchive.pollIntervalSeconds,
        ),
      ),
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
  next.mfaRequiredForAdmins = Boolean(next.mfaRequiredForAdmins);
  next.mfaRequiredForNonAdmins = Boolean(next.mfaRequiredForNonAdmins);

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
    autoApproveUnlessSuspicious: updates.autoApproveUnlessSuspicious !== undefined ? Boolean(updates.autoApproveUnlessSuspicious) : current.enrollment.autoApproveUnlessSuspicious,
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

export async function updateOidcConfig(
  updates: Partial<Config["oidc"]>,
): Promise<Config["oidc"]> {
  const current = getConfig();

  const next: Config["oidc"] = {
    ...current.oidc,
    ...updates,
    enabled:
      updates.enabled !== undefined
        ? Boolean(updates.enabled)
        : current.oidc.enabled,
    label: String(updates.label ?? current.oidc.label ?? DEFAULT_CONFIG.oidc.label).trim() || DEFAULT_CONFIG.oidc.label,
    issuer: String(updates.issuer ?? current.oidc.issuer ?? "").trim(),
    clientId: String(updates.clientId ?? current.oidc.clientId ?? "").trim(),
    clientSecret:
      typeof updates.clientSecret === "string" && updates.clientSecret.length > 0
        ? updates.clientSecret.trim()
        : current.oidc.clientSecret,
    redirectUri: String(updates.redirectUri ?? current.oidc.redirectUri ?? "").trim(),
    scopes: (() => {
      const scopes = updates.scopes !== undefined ? splitList(updates.scopes) : splitList(current.oidc.scopes);
      return scopes.length > 0 ? scopes : [...DEFAULT_CONFIG.oidc.scopes];
    })(),
    clientAuthMethod: pickClientAuthMethod(updates.clientAuthMethod ?? current.oidc.clientAuthMethod),
    autoProvision:
      updates.autoProvision !== undefined
        ? Boolean(updates.autoProvision)
        : current.oidc.autoProvision,
    allowEmailLink:
      updates.allowEmailLink !== undefined
        ? Boolean(updates.allowEmailLink)
        : current.oidc.allowEmailLink,
    defaultRole: pickRole(updates.defaultRole ?? current.oidc.defaultRole, current.oidc.defaultRole),
    allowedEmails:
      updates.allowedEmails !== undefined
        ? splitList(updates.allowedEmails).map((email) => email.toLowerCase())
        : splitList(current.oidc.allowedEmails),
    allowedDomains:
      updates.allowedDomains !== undefined
        ? splitList(updates.allowedDomains).map((domain) => domain.toLowerCase())
        : splitList(current.oidc.allowedDomains),
    groupClaim: String(updates.groupClaim ?? current.oidc.groupClaim ?? DEFAULT_CONFIG.oidc.groupClaim).trim() || DEFAULT_CONFIG.oidc.groupClaim,
    adminGroups:
      updates.adminGroups !== undefined
        ? splitList(updates.adminGroups)
        : splitList(current.oidc.adminGroups),
    operatorGroups:
      updates.operatorGroups !== undefined
        ? splitList(updates.operatorGroups)
        : splitList(current.oidc.operatorGroups),
    viewerGroups:
      updates.viewerGroups !== undefined
        ? splitList(updates.viewerGroups)
        : splitList(current.oidc.viewerGroups),
  };

  configCache = {
    ...current,
    oidc: next,
  };

  const fileConfig = readFileConfigForUpdate();
  fileConfig.oidc = next;
  await writePersistentFileConfig(fileConfig);
  return next;
}

export async function updateAppearanceConfig(
  customCSS: string,
  loginBranding?: Partial<Config["appearance"]["loginBranding"]>,
): Promise<Config["appearance"]> {
  const current = getConfig();
  const next: Config["appearance"] = {
    ...current.appearance,
    customCSS: String(customCSS || "").slice(0, 51200),
    loginBranding: cleanLoginBranding(
      loginBranding ? { ...current.appearance.loginBranding, ...loginBranding } : current.appearance.loginBranding,
      DEFAULT_CONFIG.appearance.loginBranding,
    ),
  };

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

export async function updateInputArchiveConfig(
  updates: Partial<Config["inputArchive"]>,
): Promise<Config["inputArchive"]> {
  const current = getConfig();
  const next: Config["inputArchive"] = {
    ...current.inputArchive,
    ...updates,
  };

  next.enabled = Boolean(next.enabled);
  next.retentionDays = Math.min(365, Math.max(1, Number(next.retentionDays) || 7));
  next.maxFileBytes = Math.min(50 * 1024 * 1024, Math.max(64 * 1024, Number(next.maxFileBytes) || DEFAULT_CONFIG.inputArchive.maxFileBytes));
  next.pollIntervalSeconds = Math.min(24 * 60 * 60, Math.max(0, Number(next.pollIntervalSeconds) || 0));

  configCache = {
    ...current,
    inputArchive: next,
  };

  const fileConfig = readFileConfigForUpdate();
  fileConfig.inputArchive = next;
  await writePersistentFileConfig(fileConfig);
  return next;
}

export async function updateRegistrationConfig(
  updates: Partial<Config["registration"]>,
): Promise<Config["registration"]> {
  const current = getConfig();

  const validModes = ["off", "open", "key", "approval"] as const;
  const validRoles = ["operator", "viewer"] as const;

  const next: Config["registration"] = {
    ...current.registration,
    ...updates,
  };

  if (!validModes.includes(next.mode as any)) {
    next.mode = current.registration.mode;
  }
  if (!validRoles.includes(next.defaultRole as any)) {
    next.defaultRole = current.registration.defaultRole;
  }
  next.maxUsersTotal = Math.max(0, Math.min(100000, Number(next.maxUsersTotal) || 0));
  next.defaultGroupIds = Array.isArray(next.defaultGroupIds)
    ? Array.from(new Set(next.defaultGroupIds.map((g) => Number(g)).filter((g) => Number.isFinite(g) && g > 0)))
    : [...current.registration.defaultGroupIds];

  configCache = {
    ...current,
    registration: next,
  };

  const fileConfig = readFileConfigForUpdate();
  fileConfig.registration = next;
  await writePersistentFileConfig(fileConfig);
  return next;
}

export async function updateBuildRateLimitConfig(
  updates: Partial<Config["buildRateLimit"]>,
): Promise<Config["buildRateLimit"]> {
  const current = getConfig();

  const toNumberOr = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const next: Config["buildRateLimit"] = {
    ...current.buildRateLimit,
    ...updates,
  };

  next.maxBuildsPerHour = Math.min(100, Math.max(1, toNumberOr(next.maxBuildsPerHour, 5)));
  next.maxConcurrentPerUser = Math.min(10, Math.max(1, toNumberOr(next.maxConcurrentPerUser, 1)));
  next.globalMaxConcurrent = Math.min(50, Math.max(1, toNumberOr(next.globalMaxConcurrent, 3)));

  configCache = {
    ...current,
    buildRateLimit: next,
  };

  const fileConfig = readFileConfigForUpdate();
  fileConfig.buildRateLimit = next;
  await writePersistentFileConfig(fileConfig);
  return next;
}

export async function updateThumbnailsConfig(
  updates: Partial<Config["thumbnails"]>,
): Promise<Config["thumbnails"]> {
  const current = getConfig();

  const next: Config["thumbnails"] = {
    dashboardEnabled:
      updates.dashboardEnabled !== undefined
        ? Boolean(updates.dashboardEnabled)
        : current.thumbnails.dashboardEnabled,
    wallEnabled:
      updates.wallEnabled !== undefined
        ? Boolean(updates.wallEnabled)
        : current.thumbnails.wallEnabled,
  };

  configCache = {
    ...current,
    thumbnails: next,
  };

  const fileConfig = readFileConfigForUpdate();
  fileConfig.thumbnails = next;
  await writePersistentFileConfig(fileConfig);
  return next;
}

export function getBuildSigningSecrets(): BuildSigningSecrets | null {
  const dataDir = ensureDataDir();
  const savePath = resolve(dataDir, "save.json");
  const saved = loadSaveSecrets(savePath);
  const priv = saved.buildSigning?.privateKey;
  const pub = saved.buildSigning?.publicKey;
  if (typeof priv === "string" && priv && typeof pub === "string" && pub) {
    return { privateKey: priv, publicKey: pub };
  }
  return null;
}

export function setBuildSigningSecrets(secrets: BuildSigningSecrets): void {
  const dataDir = ensureDataDir();
  const savePath = resolve(dataDir, "save.json");
  const saved = loadSaveSecrets(savePath);
  saved.buildSigning = { privateKey: secrets.privateKey, publicKey: secrets.publicKey };
  persistSaveSecrets(savePath, saved);
}

export function getClientLogSecrets(): ClientLogSecrets | null {
  const dataDir = ensureDataDir();
  const savePath = resolve(dataDir, "save.json");
  const saved = loadSaveSecrets(savePath);
  const priv = saved.clientLogs?.privateKey;
  const pub = saved.clientLogs?.publicKey;
  if (typeof priv === "string" && priv && typeof pub === "string" && pub) {
    return { privateKey: priv, publicKey: pub };
  }
  return null;
}

export function setClientLogSecrets(secrets: ClientLogSecrets): void {
  const dataDir = ensureDataDir();
  const savePath = resolve(dataDir, "save.json");
  const saved = loadSaveSecrets(savePath);
  saved.clientLogs = { privateKey: secrets.privateKey, publicKey: secrets.publicKey };
  persistSaveSecrets(savePath, saved);
}

export function getBuildBanlist(): string[] {
  return getConfig().buildSigning.banlist;
}

export function setBuildBanlist(banlist: string[]): void {
  const current = getConfig();
  const cleaned = Array.from(
    new Set(banlist.filter((v) => typeof v === "string" && v.length > 0)),
  );
  const next: Config["buildSigning"] = { banlist: cleaned };

  configCache = { ...current, buildSigning: next };

  const fileConfig = readFileConfigForUpdate();
  fileConfig.buildSigning = next;
  try {
    writeFileSync(getPersistentConfigPath(), JSON.stringify(fileConfig, null, 2));
  } catch (err) {
    logger.warn("Failed to persist buildSigning banlist", err);
  }
}

export function getExportableConfig(serverVersion: string): Record<string, unknown> {
  const config = getConfig();
  const buildSigningSecrets = getBuildSigningSecrets();
  return {
    _meta: {
      exportedAt: new Date().toISOString(),
      version: serverVersion,
    },
    auth: {
      jwtSecret: config.auth.jwtSecret,
      agentToken: config.auth.agentToken,
    },
    oidc: {
      ...config.oidc,
      clientSecret: "",
    },
    notifications: config.notifications,
    security: config.security,
    tls: config.tls,
    enrollment: config.enrollment,
    appearance: config.appearance,
    plugins: config.plugins,
    chat: config.chat,
    registration: config.registration,
    buildRateLimit: config.buildRateLimit,
    buildSigning: {
      privateKey: buildSigningSecrets?.privateKey || "",
      publicKey: buildSigningSecrets?.publicKey || "",
      banlist: config.buildSigning.banlist,
    },
    thumbnails: config.thumbnails,
    inputArchive: config.inputArchive,
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
    oidc: process.env.OVERLORD_OIDC_ENABLED || process.env.OVERLORD_OIDC_ISSUER || process.env.OVERLORD_OIDC_CLIENT_ID,
    appearance:
      process.env.OVERLORD_LOGIN_BRAND_NAME ||
      process.env.OVERLORD_BRAND_NAME ||
      process.env.OVERLORD_NAV_LOGO_URL ||
      process.env.OVERLORD_BRAND_LOGO_URL ||
      process.env.OVERLORD_LOGIN_LOGO_URL ||
      process.env.OVERLORD_LOGIN_HERO_IMAGE_URL ||
      process.env.OVERLORD_LOGIN_TITLE,
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
      const loginBranding =
        data.appearance.loginBranding && typeof data.appearance.loginBranding === "object"
          ? data.appearance.loginBranding
          : undefined;
      await updateAppearanceConfig(css, loginBranding);
      applied.push("appearance");
      if (envOverrides.appearance) {
        warnings.push("Some login branding settings may be overridden by OVERLORD_LOGIN_* environment variables after restart.");
      }
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

  if (data.registration && typeof data.registration === "object") {
    await updateRegistrationConfig(data.registration);
    applied.push("registration");
  }

  if (data.oidc && typeof data.oidc === "object") {
    const current = getConfig();
    const next: Config["oidc"] = {
      ...current.oidc,
      ...data.oidc,
      clientSecret:
        typeof data.oidc.clientSecret === "string" && data.oidc.clientSecret
          ? data.oidc.clientSecret
          : current.oidc.clientSecret,
      enabled: Boolean(data.oidc.enabled),
      scopes: splitList(data.oidc.scopes).length > 0 ? splitList(data.oidc.scopes) : current.oidc.scopes,
      clientAuthMethod: pickClientAuthMethod(data.oidc.clientAuthMethod),
      autoProvision: data.oidc.autoProvision !== undefined ? Boolean(data.oidc.autoProvision) : current.oidc.autoProvision,
      allowEmailLink: data.oidc.allowEmailLink !== undefined ? Boolean(data.oidc.allowEmailLink) : current.oidc.allowEmailLink,
      defaultRole: pickRole(data.oidc.defaultRole, current.oidc.defaultRole),
      allowedEmails: splitList(data.oidc.allowedEmails),
      allowedDomains: splitList(data.oidc.allowedDomains),
      adminGroups: splitList(data.oidc.adminGroups),
      operatorGroups: splitList(data.oidc.operatorGroups),
      viewerGroups: splitList(data.oidc.viewerGroups),
    };
    configCache = { ...current, oidc: next };
    const fileConfig = readFileConfigForUpdate();
    fileConfig.oidc = next;
    await writePersistentFileConfig(fileConfig);
    applied.push("oidc");
    if (envOverrides.oidc) {
      warnings.push("Some OIDC settings may be overridden by OVERLORD_OIDC_* environment variables after restart.");
    }
  }

  if (data.buildRateLimit && typeof data.buildRateLimit === "object") {
    await updateBuildRateLimitConfig(data.buildRateLimit);
    applied.push("buildRateLimit");
  }

  if (data.thumbnails && typeof data.thumbnails === "object") {
    await updateThumbnailsConfig(data.thumbnails);
    applied.push("thumbnails");
  }

  if (data.inputArchive && typeof data.inputArchive === "object") {
    await updateInputArchiveConfig(data.inputArchive);
    applied.push("inputArchive");
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

  if (data.buildSigning && typeof data.buildSigning === "object") {
    const incomingPriv = typeof data.buildSigning.privateKey === "string" ? data.buildSigning.privateKey : "";
    const incomingPub = typeof data.buildSigning.publicKey === "string" ? data.buildSigning.publicKey : "";
    let importedKeypair = false;

    if (incomingPriv && incomingPub) {
      const dataDir = ensureDataDir();
      const savePath = resolve(dataDir, "save.json");
      const savedSecrets = loadSaveSecrets(savePath);
      savedSecrets.buildSigning = { privateKey: incomingPriv, publicKey: incomingPub };
      persistSaveSecrets(savePath, savedSecrets);
      importedKeypair = true;
    } else if (incomingPriv || incomingPub) {
      warnings.push("buildSigning import skipped: both privateKey and publicKey are required.");
    }

    if (Array.isArray(data.buildSigning.banlist)) {
      const cleaned = data.buildSigning.banlist.filter(
        (v: unknown): v is string => typeof v === "string" && v.length > 0,
      );
      setBuildBanlist(cleaned);
    }

    applied.push(
      importedKeypair
        ? "buildSigning (keypair updated in save.json — restart required, banlist applied)"
        : "buildSigning (banlist applied)",
    );
  }

  return { applied, warnings };
}
