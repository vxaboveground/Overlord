import { webcrypto } from "node:crypto";
import {
  expect,
  request as requestFactory,
  test,
  type APIRequestContext,
} from "@playwright/test";
import { decodeMessage, encodeMessage } from "../../src/protocol";
import { ADMIN } from "./credentials";

const BASE_URL = "http://127.0.0.1:5193";
const AGENT_TOKEN = "e2e-agent-token-that-is-only-used-for-browser-tests";
const CLIENT_ID = "e2e-file-transfer-agent";

type AgentCommand = {
  type: "command";
  commandType: string;
  id?: string;
  payload?: { path?: string };
};

class TransferTestAgent {
  private socket: WebSocket | null = null;
  private downloads = new Map<string, Uint8Array>();

  setDownload(path: string, bytes: Uint8Array): void {
    this.downloads.set(path, bytes);
  }

  async connect(): Promise<void> {
    const keyPair = await webcrypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    );
    const publicKey = new Uint8Array(
      await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
    );
    const socket = new WebSocket(
      `ws://127.0.0.1:5193/api/clients/${CLIENT_ID}/stream/ws?token=${encodeURIComponent(AGENT_TOKEN)}`,
    );
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Agent enrollment timed out")), 10_000);

      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Agent WebSocket failed"));
      });
      socket.addEventListener("close", (event) => {
        if (socket.readyState !== WebSocket.OPEN) {
          clearTimeout(timeout);
          reject(new Error(`Agent WebSocket closed during enrollment (${event.code}: ${event.reason})`));
        }
      });
      socket.addEventListener("message", async (event) => {
        const message = decodeMessage(event.data as ArrayBuffer) as any;
        if (message.type === "enrollment_challenge") {
          const nonce = Buffer.from(message.nonce, "base64");
          const signature = await webcrypto.subtle.sign("Ed25519", keyPair.privateKey, nonce);
          socket.send(encodeMessage({
            type: "hello",
            id: CLIENT_ID,
            host: "e2e-transfer-host",
            os: "E2E",
            arch: "x64",
            version: "e2e",
            user: "playwright",
            monitors: 1,
            hwid: CLIENT_ID,
            publicKey: Buffer.from(publicKey).toString("base64"),
            signature: Buffer.from(signature).toString("base64"),
          }));
          return;
        }
        if (message.type === "hello_ack") {
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (message.type === "command") {
          this.handleCommand(message as AgentCommand);
        }
      });
    });
  }

  close(): void {
    this.socket?.close(1000, "test_complete");
    this.socket = null;
  }

  private handleCommand(command: AgentCommand): void {
    if (command.commandType !== "file_download" || !command.id) return;
    const path = command.payload?.path || "";
    const bytes = this.downloads.get(path);
    if (!bytes) {
      this.socket?.send(encodeMessage({
        type: "file_download",
        commandId: command.id,
        path,
        data: new Uint8Array(),
        offset: 0,
        total: 0,
        error: "E2E fixture not found",
      }));
      return;
    }
    this.socket?.send(encodeMessage({
      type: "file_download",
      commandId: command.id,
      path,
      data: bytes,
      offset: 0,
      total: bytes.byteLength,
      chunkIndex: 0,
      chunksTotal: 1,
    }));
  }
}

test.describe("file transfer HTTP API runtime", () => {
  let api: APIRequestContext;
  let agent: TransferTestAgent;

  test.beforeAll(async () => {
    const loginApi = await requestFactory.newContext({ baseURL: BASE_URL });
    const login = await loginApi.post("/api/login", {
      data: { user: ADMIN.username, pass: ADMIN.password },
    });
    expect(login.ok()).toBeTruthy();
    const { token } = await login.json();
    await loginApi.dispose();
    api = await requestFactory.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    const enrollment = await api.post("/api/enrollment/settings", {
      data: { requireApproval: false, autoApproveUnlessSuspicious: false },
    });
    expect(enrollment.ok()).toBeTruthy();

    agent = new TransferTestAgent();
    await agent.connect();
  });

  test.afterAll(async () => {
    agent?.close();
    if (api) {
      await api.post("/api/enrollment/settings", {
        data: { requireApproval: true, autoApproveUnlessSuspicious: false },
      });
      await api.dispose();
    }
  });

  test("uploads bytes for a one-time authenticated agent pull", async () => {
    const remotePath = "C:\\Temp\\overlord-e2e-upload.bin";
    const uploadBytes = Buffer.from("playwright upload payload\n\u0000with binary bytes", "utf8");

    const requestUpload = await api.post("/api/file/upload/request", {
      data: {
        clientId: CLIENT_ID,
        path: remotePath,
        fileName: "overlord-e2e-upload.bin",
      },
    });
    expect(requestUpload.ok()).toBeTruthy();
    const { uploadUrl } = await requestUpload.json();

    const stageUpload = await api.put(uploadUrl, {
      data: uploadBytes,
      headers: { "Content-Type": "application/octet-stream" },
    });
    expect(stageUpload.ok()).toBeTruthy();
    const staged = await stageUpload.json();
    expect(staged).toMatchObject({
      ok: true,
      size: uploadBytes.byteLength,
      path: remotePath,
    });

    const pullHeaders = {
      "x-agent-token": AGENT_TOKEN,
      "x-overlord-client-id": CLIENT_ID,
    };
    const pull = await api.get(staged.pullUrl, { headers: pullHeaders });
    expect(pull.ok()).toBeTruthy();
    expect(Buffer.from(await pull.body())).toEqual(uploadBytes);

    const replay = await api.get(staged.pullUrl, { headers: pullHeaders });
    expect(replay.status()).toBe(404);
  });

  test("streams a requested agent file through the download API", async () => {
    const remotePath = "C:\\Temp\\overlord-e2e-download.bin";
    const downloadBytes = new Uint8Array([
      0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff,
      ...Buffer.from("playwright download payload", "utf8"),
    ]);
    agent.setDownload(remotePath, downloadBytes);

    const requestDownload = await api.post("/api/file/download/request", {
      data: { clientId: CLIENT_ID, path: remotePath },
    });
    expect(requestDownload.ok()).toBeTruthy();
    const { downloadUrl } = await requestDownload.json();

    const download = await api.get(downloadUrl);
    expect(download.ok()).toBeTruthy();
    expect(download.headers()["content-type"]).toContain("application/octet-stream");
    expect(download.headers()["content-disposition"]).toContain("overlord-e2e-download.bin");
    expect(Buffer.from(await download.body())).toEqual(Buffer.from(downloadBytes));
  });
});
