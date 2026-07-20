import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("WebRTC input stays inactive until start and then forwards mouse and keyboard", async ({ page }) => {
  await login(page);
  await page.addInitScript(() => {
    const sent: ArrayBuffer[] = [];
    Object.defineProperty(window, "__rdSent", { value: sent, configurable: true });

    class FakeWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      readyState = FakeWebSocket.OPEN;
      bufferedAmount = 0;
      binaryType: BinaryType = "blob";

      constructor(_url: string | URL) {
        super();
        Object.defineProperty(window, "__rdSocket", { value: this, configurable: true });
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(data: ArrayBuffer | ArrayBufferView | Blob | string) {
        if (data instanceof ArrayBuffer) sent.push(data);
        else if (ArrayBuffer.isView(data)) {
          sent.push(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
        }
      }

      close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent("close"));
      }
    }

    Object.defineProperty(window, "WebSocket", { value: FakeWebSocket, configurable: true });
  });

  await page.goto("/remotedesktop?clientId=webrtc-input-test");
  await expect(page.locator("#canvasContainer")).toHaveAttribute("tabindex", "0");
  await page.evaluate(async () => {
    const { encodeMsgpack } = await import("/assets/msgpack-helpers.js");
    const encoded = encodeMsgpack({
      type: "desktop_encoder_capabilities",
      display: 0,
      profiles: [
        { maxHeight: 720, width: 1280, height: 720, fps: 60, label: "60 FPS - 720p" },
        { maxHeight: 1080, width: 1920, height: 1080, fps: 60, label: "60 FPS - 1080p" },
      ],
      codecs: [{ codec: "h264", transports: ["websocket", "webrtc"] }],
      selectedCodec: "h264",
      fallbackCodecs: ["h264"],
      transport: "websocket",
    });
    const data = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    const socket = (window as typeof window & { __rdSocket: EventTarget }).__rdSocket;
    socket.dispatchEvent(new MessageEvent("message", { data }));
  });
  await expect(page.locator("#streamProfileSelect option[value='1440:60']")).toHaveCount(1);
  await expect(page.locator("#streamProfileSelect option[value='2160:60']")).toHaveCount(1);
  await expect(page.locator("#requestKeyframeBtn")).toBeDisabled();

  await page.evaluate(() => {
    const sent = (window as typeof window & { __rdSent: ArrayBuffer[] }).__rdSent;
    sent.length = 0;
    const mouseCtrl = document.querySelector<HTMLInputElement>("#mouseCtrl")!;
    const kbdCtrl = document.querySelector<HTMLInputElement>("#kbdCtrl")!;
    const cursorCtrl = document.querySelector<HTMLInputElement>("#cursorCtrl")!;
    mouseCtrl.checked = true;
    mouseCtrl.dispatchEvent(new Event("change"));
    kbdCtrl.checked = true;
    kbdCtrl.dispatchEvent(new Event("change"));
    cursorCtrl.checked = true;
    cursorCtrl.dispatchEvent(new Event("change"));
    const canvas = document.querySelector<HTMLCanvasElement>("#frameCanvas")!;
    const video = document.querySelector<HTMLVideoElement>("#webrtcVideo")!;
    canvas.style.display = "none";
    video.style.display = "block";
    Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true });
    video.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 960,
      bottom: 540,
      width: 960,
      height: 540,
      toJSON() { return this; },
    });
    const renderSurface = document.querySelector<HTMLElement>("#renderSurface")!;
    renderSurface.getBoundingClientRect = video.getBoundingClientRect;
    canvas.getBoundingClientRect = video.getBoundingClientRect;

    video.dispatchEvent(new MouseEvent("mousedown", { clientX: 480, clientY: 270, button: 0, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  });

  await page.evaluate(async () => {
    const { encodeMsgpack } = await import("/assets/msgpack-helpers.js");
    const encoded = encodeMsgpack({
      type: "desktop_cursor",
      x: 960,
      y: 540,
      width: 1920,
      height: 1080,
      visible: true,
      cursorWidth: 32,
      cursorHeight: 32,
      hotspotX: 4,
      hotspotY: 6,
      image: Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (char) => char.charCodeAt(0)),
    });
    const data = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    const socket = (window as typeof window & { __rdSocket: EventTarget }).__rdSocket;
    socket.dispatchEvent(new MessageEvent("message", { data }));
  });

  await expect(page.locator("#frameCanvas")).toHaveCSS("cursor", "default");
  await expect(page.locator("#webrtcVideo")).toHaveCSS("cursor", "default");
  await expect(page.locator("#remoteCursor")).toBeHidden();

  await page.evaluate(() => {
    const mouseCtrl = document.querySelector<HTMLInputElement>("#mouseCtrl")!;
    mouseCtrl.checked = false;
    mouseCtrl.dispatchEvent(new Event("change"));
  });
  await expect(page.locator("#remoteCursor")).toBeVisible();
  await expect(page.locator("#remoteCursor")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 478, 267)");
  await expect(page.locator("#frameCanvas")).toHaveCSS("cursor", "default");
  await expect(page.locator("#remoteCursor")).toHaveCSS("width", "16px");
  await expect(page.locator("#remoteCursor")).toHaveCSS("height", "16px");

  await page.evaluate(() => {
    const mouseCtrl = document.querySelector<HTMLInputElement>("#mouseCtrl")!;
    const hideLocalCursorCtrl = document.querySelector<HTMLInputElement>("#hideLocalCursorCtrl")!;
    mouseCtrl.checked = true;
    mouseCtrl.dispatchEvent(new Event("change"));
    hideLocalCursorCtrl.checked = true;
    hideLocalCursorCtrl.dispatchEvent(new Event("change"));
  });
  await expect(page.locator("#frameCanvas")).toHaveCSS("cursor", "none");
  await expect(page.locator("#webrtcVideo")).toHaveCSS("cursor", "none");
  await expect(page.locator("#remoteCursor")).toBeVisible();

  await page.evaluate(() => {
    const hideLocalCursorCtrl = document.querySelector<HTMLInputElement>("#hideLocalCursorCtrl")!;
    hideLocalCursorCtrl.checked = false;
    hideLocalCursorCtrl.dispatchEvent(new Event("change"));
  });
  await expect(page.locator("#frameCanvas")).toHaveCSS("cursor", "default");
  await expect(page.locator("#remoteCursor")).toBeHidden();
  await expect.poll(async () => page.evaluate(async () => {
    const sent = (window as typeof window & { __rdSent: ArrayBuffer[] }).__rdSent;
    const { decodeMsgpack } = await import("/assets/msgpack-helpers.js");
    return sent.map((message) => decodeMsgpack(message))
      .filter((message) => message.type === "desktop_enable_cursor");
  })).toContainEqual(expect.objectContaining({
    type: "desktop_enable_cursor",
    enabled: true,
  }));

  await expect.poll(async () => page.evaluate(async () => {
    const sent = (window as typeof window & { __rdSent: ArrayBuffer[] }).__rdSent;
    const { decodeMsgpack } = await import("/assets/msgpack-helpers.js");
    return sent.map((message) => decodeMsgpack(message))
      .filter((message) => /^(mouse_|key_|text_input)/.test(message.type));
  })).toEqual([]);

  await page.locator("#startBtn").click();
  await page.evaluate(() => {
    const sent = (window as typeof window & { __rdSent: ArrayBuffer[] }).__rdSent;
    sent.length = 0;
    const video = document.querySelector<HTMLVideoElement>("#webrtcVideo")!;
    video.dispatchEvent(new MouseEvent("mousemove", { clientX: 480, clientY: 270, bubbles: true }));
    video.dispatchEvent(new MouseEvent("mousedown", { clientX: 480, clientY: 270, button: 0, bubbles: true }));
    video.dispatchEvent(new MouseEvent("mouseup", { clientX: 480, clientY: 270, button: 0, bubbles: true }));
    video.dispatchEvent(new WheelEvent("wheel", { clientX: 480, clientY: 270, deltaY: -80, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  });

  await expect.poll(async () => page.evaluate(async () => {
    const sent = (window as typeof window & { __rdSent: ArrayBuffer[] }).__rdSent;
    const { decodeMsgpack } = await import("/assets/msgpack-helpers.js");
    return sent.map((message) => decodeMsgpack(message));
  })).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "mouse_move", x: 960, y: 540 }),
    expect.objectContaining({ type: "mouse_down", button: 0, x: 960, y: 540 }),
    expect.objectContaining({ type: "mouse_up", button: 0, x: 960, y: 540 }),
    expect.objectContaining({ type: "mouse_wheel", delta: 80, x: 960, y: 540 }),
    expect.objectContaining({ type: "key_down", key: "Enter", code: "Enter" }),
    expect.objectContaining({ type: "key_up", key: "Enter", code: "Enter" }),
  ]));

  await page.evaluate(() => {
    const socket = (window as typeof window & { __rdSocket: EventTarget }).__rdSocket;
    const framePacket = Uint8Array.from([0x46, 0x52, 0x4d, 0, 0, 0, 0, 0]).buffer;
    socket.dispatchEvent(new MessageEvent("message", { data: framePacket }));
  });
  await expect(page.locator("#requestKeyframeBtn")).toBeEnabled();
  await page.waitForTimeout(550);
  await page.evaluate(() => {
    const sent = (window as typeof window & { __rdSent: ArrayBuffer[] }).__rdSent;
    sent.length = 0;
    const socket = (window as typeof window & { __rdSocket: EventTarget }).__rdSocket;
    const framePacket = Uint8Array.from([0x46, 0x52, 0x4d, 0, 0, 0, 0, 0]).buffer;
    socket.dispatchEvent(new MessageEvent("message", { data: framePacket }));
  });
  await expect.poll(async () => page.evaluate(async () => {
    const sent = (window as typeof window & { __rdSent: ArrayBuffer[] }).__rdSent;
    const { decodeMsgpack } = await import("/assets/msgpack-helpers.js");
    return sent.map((message) => decodeMsgpack(message))
      .filter((message) => message.type === "desktop_request_keyframe");
  })).toEqual([]);
  await page.locator("#rdSettingsBtn").click();
  await page.locator("#requestKeyframeBtn").click();
  await expect.poll(async () => page.evaluate(async () => {
    const sent = (window as typeof window & { __rdSent: ArrayBuffer[] }).__rdSent;
    const { decodeMsgpack } = await import("/assets/msgpack-helpers.js");
    return sent.map((message) => decodeMsgpack(message))
      .filter((message) => message.type === "desktop_request_keyframe" && message.reason === "manual_viewer");
  })).toEqual([
    expect.objectContaining({ type: "desktop_request_keyframe", reason: "manual_viewer" }),
  ]);
});
