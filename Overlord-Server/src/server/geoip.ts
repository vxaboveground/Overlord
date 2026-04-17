/**
 * Enhanced GeoIP lookup with fallback to external API.
 * geoip-lite uses a local database that can be stale.
 * This module adds a fallback to ip-api.com (free, no auth required).
 */

import geoip from "geoip-lite";
import { getConfig } from "../config";

type GeoResult = {
  country: string | null;
  asn: string | null;
  isp: string | null;
};

// Cache to avoid repeated API calls for the same IP
const cache = new Map<string, { result: GeoResult; expires: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Look up GeoIP info for an IP address.
 * Tries local geoip-lite first, then falls back to ip-api.com if configured.
 */
export async function lookupGeoIP(ip: string): Promise<GeoResult> {
  // Check cache first
  const cached = cache.get(ip);
  if (cached && cached.expires > Date.now()) {
    return cached.result;
  }

  const config = getConfig();
  const localResult = geoip.lookup(ip);

  // If local lookup succeeded and we don't prefer client-reported, use it
  if (localResult?.country) {
    const result: GeoResult = {
      country: localResult.country,
      asn: localResult.range ? String(localResult.range) : null,
      isp: null,
    };
    cache.set(ip, { result, expires: Date.now() + CACHE_TTL_MS });
    return result;
  }

  // Fallback to external API if configured
  if (config.geoip?.fallbackApi) {
    try {
      const apiResult = await lookupViaApi(ip);
      cache.set(ip, { result: apiResult, expires: Date.now() + CACHE_TTL_MS });
      return apiResult;
    } catch (err) {
      console.warn(`[geoip] API fallback failed for ${ip}:`, err);
    }
  }

  return { country: null, asn: null, isp: null };
}

/**
 * Resolve country code with fallback logic.
 * Priority: geoip lookup > client-reported > "ZZ"
 */
export async function resolveCountry(
  ip: string | undefined,
  clientReported: string | undefined,
  existing: string | undefined,
): Promise<string> {
  const config = getConfig();

  // If we prefer client-reported country and it's valid, use it
  if (config.geoip?.preferClientReported && clientReported && /^[A-Z]{2}$/i.test(clientReported)) {
    return clientReported.toUpperCase();
  }

  // Try GeoIP lookup
  if (ip) {
    const geo = await lookupGeoIP(ip);
    if (geo?.country && /^[A-Z]{2}$/i.test(geo.country)) {
      return geo.country.toUpperCase();
    }
  }

  // Fall back to client-reported if valid
  if (clientReported && /^[A-Z]{2}$/i.test(clientReported)) {
    return clientReported.toUpperCase();
  }

  // Last resort: existing or "ZZ"
  if (existing && /^[A-Z]{2}$/i.test(existing)) {
    return existing.toUpperCase();
  }

  return "ZZ";
}

async function lookupViaApi(ip: string): Promise<GeoResult> {
  const res = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode,as,isp`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`ip-api.com returned ${res.status}`);
  }
  const data = await res.json();
  if (data.status !== "success") {
    throw new Error(`ip-api.com error: ${data.message}`);
  }
  return {
    country: data.countryCode || null,
    asn: data.as || null,
    isp: data.isp || null,
  };
}
