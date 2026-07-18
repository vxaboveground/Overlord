export type DesktopCodecTransport = "websocket" | "webrtc";

export type DesktopCodecCapability = {
  codec: string;
  encoders?: string[];
  transports?: string[];
  hardware?: boolean;
};

export type DesktopCodecNegotiation = {
  selectedCodec: string;
  fallbackCodecs: string[];
  transport: DesktopCodecTransport;
};

const KNOWN_CODECS = new Set(["hevc", "h264", "jpeg", "raw"]);
const DEFAULT_PREFERENCE = ["h264", "jpeg", "raw"];

function normalizeCodec(value: unknown): string {
  const codec = String(value || "").trim().toLowerCase();
  if (codec === "h265") return "hevc";
  if (codec === "mjpeg" || codec === "jpg") return "jpeg";
  return KNOWN_CODECS.has(codec) ? codec : "";
}

function normalizeTransport(value: unknown): DesktopCodecTransport {
  const transport = String(value || "").trim().toLowerCase();
  return transport === "webrtc" || transport === "relayed" || transport === "p2p"
    ? "webrtc"
    : "websocket";
}

function normalizeDeclaredTransport(value: unknown): DesktopCodecTransport | "" {
  const transport = String(value || "").trim().toLowerCase();
  if (transport === "websocket") return "websocket";
  if (transport === "webrtc" || transport === "relayed" || transport === "p2p") return "webrtc";
  return "";
}

function decoderCodecSet(values: unknown): Set<string> {
  if (!Array.isArray(values)) return new Set();
  return new Set(values.map(normalizeCodec).filter(Boolean));
}

function encoderCodecSet(
  values: unknown,
  transport: DesktopCodecTransport,
): Set<string> {
  if (!Array.isArray(values)) return new Set();
  const codecs = new Set<string>();
  for (const value of values) {
    if (typeof value === "string") {
      const codec = normalizeCodec(value);
      if (codec) codecs.add(codec);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const capability = value as DesktopCodecCapability;
    const codec = normalizeCodec(capability.codec);
    if (!codec) continue;
    const transports = Array.isArray(capability.transports)
      ? capability.transports.map(normalizeDeclaredTransport).filter(Boolean)
      : ["websocket" as const];
    if (transports.includes(transport)) codecs.add(codec);
  }
  return codecs;
}

export function negotiateDesktopCodec(options: {
  encoderCodecs: unknown;
  decoderCodecs: unknown;
  preferredCodecs?: unknown;
  transport?: unknown;
}): DesktopCodecNegotiation {
  const transport = normalizeTransport(options.transport);
  const encoders = encoderCodecSet(options.encoderCodecs, transport);
  const decoders = decoderCodecSet(options.decoderCodecs);
  const requested = Array.isArray(options.preferredCodecs)
    ? options.preferredCodecs.map(normalizeCodec).filter(Boolean)
    : [];
  const preference = [...new Set(requested.length > 0 ? requested : DEFAULT_PREFERENCE)];
  const fallbackCodecs = preference.filter((codec) => encoders.has(codec) && decoders.has(codec));
  return {
    selectedCodec: fallbackCodecs[0] || "",
    fallbackCodecs,
    transport,
  };
}
