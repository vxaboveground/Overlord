/**
 * GeoIP lookup using the local geoip-lite database only.
 * No external IP lookup services are used.
 */

import geoip from "geoip-lite";
import { getConfig } from "../config";

type GeoResult = {
  country: string | null;
  asn: string | null;
  isp: string | null;
};

// Cache to avoid repeated lookups for the same IP
const cache = new Map<string, { result: GeoResult; expires: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Look up GeoIP info for an IP address using geoip-lite locally.
 */
export async function lookupGeoIP(ip: string): Promise<GeoResult> {
  const cached = cache.get(ip);
  if (cached && cached.expires > Date.now()) {
    return cached.result;
  }

  const localResult = geoip.lookup(ip);
  const result: GeoResult = {
    country: localResult?.country || null,
    asn: localResult?.range ? String(localResult.range) : null,
    isp: null,
  };

  cache.set(ip, { result, expires: Date.now() + CACHE_TTL_MS });
  return result;
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
