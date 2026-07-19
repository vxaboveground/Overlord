import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("WebRTC video forwards mouse and keyboard input", async ({ page }) => {
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

  await page.evaluate(() => {
    const mouseCtrl = document.querySelector<HTMLInputElement>("#mouseCtrl")!;
    const kbdCtrl = document.querySelector<HTMLInputElement>("#kbdCtrl")!;
    mouseCtrl.checked = true;
    mouseCtrl.dispatchEvent(new Event("change"));
    kbdCtrl.checked = true;
    kbdCtrl.dispatchEvent(new Event("change"));
    const sent = (window as typeof window & { __rdSent: ArrayBuffer[] }).__rdSent;
    sent.length = 0;
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
});
