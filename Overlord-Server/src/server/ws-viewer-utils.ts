import type { ServerWebSocket } from "bun";
import { decode as msgpackDecode, encode as msgpackEncode } from "@msgpack/msgpack";
import { logger } from "../logger";
import { metrics } from "../metrics";
import type { SocketData } from "../sessions/types";

export function decodeViewerPayload(raw: string | ArrayBuffer | Uint8Array): any | null {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  try {
    const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    return msgpackDecode(buf);
  } catch {
    return null;
  }
}

export function safeSendViewer(
  ws: ServerWebSocket<SocketData>,
  payload: unknown,
  logContext = "viewer",
) {
  try {
    ws.send(msgpackEncode(payload));
  } catch (err) {
    logger.error(`[${logContext}] viewer send failed`, err);
  }
}

export function buildViewerFrameBuffer(bytes: Uint8Array, header?: any): Uint8Array {
  const meta = new Uint8Array(8);
  meta[0] = 0x46;
  meta[1] = 0x52;
  meta[2] = 0x4d;
  meta[3] = 1;
  meta[4] = (header?.monitor ?? 0) & 0xff;
  meta[5] = (header?.fps ?? 0) & 0xff;
  const fmt = header?.format === "blocks"
    ? 2
    : header?.format === "blocks_raw"
    ? 3
    : header?.format === "h264"
    ? 4
    : 1;
  meta[6] = fmt;
  meta[7] = 0;

  const buf = new Uint8Array(8 + bytes.length);
  buf.set(meta, 0);
  buf.set(bytes, 8);
  return buf;
}

export function safeSendViewerFrame(
  ws: ServerWebSocket<SocketData>,
  bytes: Uint8Array,
  header?: any,
  logContext = "rd",
): number {
  try {
    const buf = buildViewerFrameBuffer(bytes, header);
    ws.send(buf);
    metrics.recordBytesSent(buf.length);
    return buf.length;
  } catch (err) {
    logger.error(`[${logContext}] viewer frame send failed`, err);
    return 0;
  }
}
