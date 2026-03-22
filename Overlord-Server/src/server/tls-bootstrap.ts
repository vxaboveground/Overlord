import { certificatesExist, generateSelfSignedCert, getLocalIPs, isOpenSSLAvailable } from "../certGenerator";
import { logger } from "../logger";
import { X509Certificate } from "crypto";
import path from "path";

type TlsBootstrapParams = {
  certPath: string;
  keyPath: string;
  caPath?: string;
  certbot?: {
    enabled: boolean;
    livePath: string;
    domain: string;
    certFileName: string;
    keyFileName: string;
    caFileName: string;
  };
};

type TlsBootstrapResult = {
  tlsOptions: { cert?: string; key?: string; ca?: string };
  certPathUsed: string;
  source: "certbot" | "configured" | "self-signed";
};

export async function prepareTlsOptions(params: TlsBootstrapParams): Promise<TlsBootstrapResult> {
  logger.info("[TLS] TLS/HTTPS is always enabled for security");

  const isDebugRuntime = String(process.env.NODE_ENV || "development").toLowerCase() !== "production";
  const certbotEnabled = Boolean(params.certbot?.enabled);

  if (certbotEnabled && !isDebugRuntime) {
    const certbotDomain = String(params.certbot?.domain || "").trim();
    if (!certbotDomain) {
      throw new Error("Certbot TLS is enabled but no domain is configured");
    }

    const certPath = path.join(params.certbot!.livePath, certbotDomain, params.certbot!.certFileName);
    const keyPath = path.join(params.certbot!.livePath, certbotDomain, params.certbot!.keyFileName);
    const caPath = path.join(params.certbot!.livePath, certbotDomain, params.certbot!.caFileName);

    if (!certificatesExist(certPath, keyPath)) {
      throw new Error(
        `[TLS] Certbot certificates not found. Expected cert=${certPath} key=${keyPath}. ` +
          "Verify your letsencrypt volume mount and certbot domain settings.",
      );
    }

    logger.info(`[TLS] Using certbot certificates for domain ${certbotDomain}`);

    const tlsOptions: { cert?: string; key?: string; ca?: string } = {
      cert: await Bun.file(certPath).text(),
      key: await Bun.file(keyPath).text(),
    };

    const caFile = Bun.file(caPath);
    if (await caFile.exists()) {
      tlsOptions.ca = await caFile.text();
    }

    return {
      tlsOptions,
      certPathUsed: certPath,
      source: "certbot",
    };
  }

  if (certbotEnabled && isDebugRuntime) {
    logger.info("[TLS] Certbot mode is enabled but ignored in debug runtime (NODE_ENV != production)");
  }

  let source: "configured" | "self-signed" = "configured";

  if (!certificatesExist(params.certPath, params.keyPath)) {
    source = "self-signed";
    logger.info("[TLS] Certificates not found, generating self-signed certificates...");

    if (!(await isOpenSSLAvailable())) {
      logger.error("[TLS] ERROR: OpenSSL is not installed or not in PATH");
      logger.error("[TLS] Please install OpenSSL:");
      logger.error("[TLS]   - Linux: apt install openssl / yum install openssl");
      logger.error("[TLS]   - macOS: brew install openssl");
      logger.error("[TLS]   - Windows: choco install openssl or download from https://slproweb.com/products/Win32OpenSSL.html");
      throw new Error("OpenSSL is required for certificate generation");
    }

    const localIPs = getLocalIPs();
    const hostname = process.env.OVERLORD_HOSTNAME || "localhost";

    try {
      await generateSelfSignedCert({
        certPath: params.certPath,
        keyPath: params.keyPath,
        commonName: hostname,
        daysValid: 3650,
        additionalIPs: localIPs,
      });
    } catch (err) {
      logger.error("[TLS] Failed to generate certificates:", err);
      throw err;
    }
  } else {
    logger.info(`[TLS] Using existing certificates: ${params.certPath}`);
  }

  try {
    const certFile = Bun.file(params.certPath);
    const keyFile = Bun.file(params.keyPath);

    const tlsOptions: { cert?: string; key?: string; ca?: string } = {
      cert: await certFile.text(),
      key: await keyFile.text(),
    };

    if (params.caPath) {
      const caFile = Bun.file(params.caPath);
      if (await caFile.exists()) {
        tlsOptions.ca = await caFile.text();
        logger.info("[TLS] Client certificate verification enabled");
      }
    }

    if (source === "configured" && tlsOptions.cert) {
      try {
        const x509 = new X509Certificate(tlsOptions.cert);
        if (x509.issuer === x509.subject) {
          source = "self-signed";
        }
      } catch { }
    }

    return {
      tlsOptions,
      certPathUsed: params.certPath,
      source,
    };
  } catch (err) {
    logger.error("[TLS] Failed to load certificates:", err);
    throw err;
  }
}

export function logServerStartup(
  server: { hostname?: string; port?: number },
  certPath: string,
  source: "certbot" | "configured" | "self-signed",
): void {
  const hostname = server.hostname || "0.0.0.0";
  const port = server.port ?? 0;
  const localIPs = getLocalIPs();
  logger.info("========================================");
  logger.info("Overlord Server - SECURE MODE (TLS Always On)");
  logger.info("========================================");
  logger.info(`HTTPS: https://${hostname}:${port}`);
  logger.info(`WSS:   wss://${hostname}:${port}/api/clients/{id}/stream/ws`);
  if (localIPs.length > 0) {
    logger.info("\nLocal network addresses:");
    localIPs.forEach((ip) => logger.info(`  - https://${ip}:${port}`));
  }
  if (source === "certbot") {
    logger.info("\nUsing certbot TLS certificate");
    logger.info(`  Certificate: ${certPath}`);
  } else if (source === "configured") {
    logger.info("\nUsing configured TLS certificate");
    logger.info(`  Certificate: ${certPath}`);
  } else {
    logger.info("\nUsing self-signed TLS certificate");
    logger.info(`  Clients must trust: ${certPath}`);
    logger.info("  Or use: OVERLORD_TLS_INSECURE_SKIP_VERIFY=true (dev only)");
  }
  logger.info("========================================");
}
