import { afterEach, describe, expect, test } from "bun:test";
import * as clientManager from "../clientManager";
import { decodeMessage } from "../protocol";
import * as sessionManager from "../sessions/sessionManager";
import type { SocketData } from "../sessions/types";
import type { ClientInfo } from "../types";
import {
  handleRemoteDesktopViewerMessage,
  handleRemoteDesktopViewerOpen,
  rdStreamingState,
} from "./ws-console-rd-hvnc";

type MockWs = {
  data: SocketData;
  sent: unknown[];
  closedCode?: number;
  closedReason?: string;
  send: (msg: unknown) => void;
  close: (code: number, reason: string) => void;
  getBufferedAmount: () => number;
};

const clientIdsToCleanup = new Set<string>();

function createMockWs(data: Partial<SocketData>): MockWs {
  return {
    data: {
      role: "rd_viewer",
      clientId: "rd-test-client",
      ...data,
    } as SocketData,
    sent: [],
    send(msg: unknown) {
      this.sent.push(msg);
    },
    close(code: number, reason: string) {
      this.closedCode = code;
      this.closedReason = reason;
    },
    getBufferedAmount() {
      return 0;
    },
  };
}

function createClient(id: string) {
  const agentWs = createMockWs({ role: "client", clientId: id });
  const info: ClientInfo = {
    id,
    role: "client",
    ws: agentWs,
    lastSeen: Date.now(),
    online: true,
    host: "rd-test-host",
    os: "windows",
    user: "tester",
    monitors: 1,
  };
  clientManager.addClient(id, info);
  clientIdsToCleanup.add(id);
  return { info, agentWs };
}

function agentCommands(ws: MockWs) {
  return ws.sent.map((msg) => decodeMessage(msg as Uint8Array) as any);
}

afterEach(() => {
  for (const clientId of clientIdsToCleanup) {
    for (const session of sessionManager.getRdSessionsForClient(clientId)) {
      sessionManager.deleteRdSession(session.id);
    }
    rdStreamingState.delete(clientId);
    clientManager.deleteClient(clientId);
  }
  clientIdsToCleanup.clear();
});

describe("remote desktop viewer control", () => {
  test("starts once, ignores duplicate starts, and only stops after the last viewer leaves", () => {
    const clientId = `rd-control-${Date.now().toString(36)}`;
    const { agentWs } = createClient(clientId);
    const firstViewer = createMockWs({ clientId });
    const secondViewer = createMockWs({ clientId });

    handleRemoteDesktopViewerOpen(firstViewer as any);
    handleRemoteDesktopViewerOpen(secondViewer as any);

    handleRemoteDesktopViewerMessage(firstViewer as any, JSON.stringify({ type: "desktop_start" }));
    handleRemoteDesktopViewerMessage(secondViewer as any, JSON.stringify({ type: "desktop_start" }));

    let commands = agentCommands(agentWs);
    expect(commands.filter((msg) => msg.commandType === "desktop_start")).toHaveLength(1);
    expect(rdStreamingState.get(clientId)?.isStreaming).toBe(true);

    handleRemoteDesktopViewerMessage(firstViewer as any, JSON.stringify({ type: "desktop_stop" }));

    commands = agentCommands(agentWs);
    expect(commands.filter((msg) => msg.commandType === "desktop_stop")).toHaveLength(0);
    expect(rdStreamingState.get(clientId)?.isStreaming).toBe(true);

    sessionManager.deleteRdSession(firstViewer.data.sessionId!);
    handleRemoteDesktopViewerMessage(secondViewer as any, JSON.stringify({ type: "desktop_stop" }));

    commands = agentCommands(agentWs);
    expect(commands.filter((msg) => msg.commandType === "desktop_stop")).toHaveLength(1);
    expect(commands.filter((msg) => msg.commandType === "webrtc_stop")).toHaveLength(1);
    expect(rdStreamingState.get(clientId)?.isStreaming).toBe(false);
  });

  test("does not forward desktop_start when a macOS client is missing required permissions", () => {
    const clientId = `rd-mac-perms-${Date.now().toString(36)}`;
    const { info, agentWs } = createClient(clientId);
    info.os = "darwin";
    info.permissions = { screenRecording: false, accessibility: true };
    const viewer = createMockWs({ clientId });

    handleRemoteDesktopViewerOpen(viewer as any);
    handleRemoteDesktopViewerMessage(viewer as any, JSON.stringify({ type: "desktop_start" }));

    expect(agentCommands(agentWs).filter((msg) => msg.commandType === "desktop_start")).toHaveLength(0);
    expect(rdStreamingState.get(clientId)?.isStreaming).not.toBe(true);
    expect(viewer.sent.length).toBeGreaterThan(0);
  });

  test("reasserts desktop_start when server stream state is stale", () => {
    const clientId = `rd-stale-${Date.now().toString(36)}`;
    const { agentWs } = createClient(clientId);
    const viewer = createMockWs({ clientId });
    rdStreamingState.set(clientId, {
      isStreaming: true,
      display: 0,
      quality: 90,
      codec: "h264",
      softwareH264: false,
      duplication: true,
      maxHeight: 1080,
      maxFps: 120,
      lastFps: 1,
      lastFrameAt: 0,
      startedAt: Date.now() - 5000,
    });

    handleRemoteDesktopViewerOpen(viewer as any);
    handleRemoteDesktopViewerMessage(viewer as any, JSON.stringify({ type: "desktop_start" }));

    const commands = agentCommands(agentWs);
    expect(commands.filter((msg) => msg.commandType === "desktop_start")).toHaveLength(1);
    expect(commands.filter((msg) => msg.commandType === "desktop_request_keyframe")).toHaveLength(0);
    expect(rdStreamingState.get(clientId)?.isStreaming).toBe(true);
  });
});
