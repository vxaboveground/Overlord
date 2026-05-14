import { encodeMsgpack, decodeMsgpack } from "./msgpack-helpers.js";
import { checkFeatureAccess } from "./feature-gate.js";
import { WhepClient } from "./whep.js";
import { P2PClient } from "./webrtc-p2p.js";

(async function () {
  const clientId = new URLSearchParams(location.search).get("clientId");
  if (!clientId) {
    alert("Missing clientId");
    return;
  }

  const allowed = await checkFeatureAccess("webcam", clientId);
  if (!allowed) return;

  const clientLabel = document.getElementById("clientLabel");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const screenshotBtn = document.getElementById("screenshotBtn");
  const cameraSelect = document.getElementById("cameraSelect");
  const refreshCameras = document.getElementById("refreshCameras");
  const fpsInput = document.getElementById("fpsInput");
  const applyFps = document.getElementById("applyFps");
  const qualitySlider = document.getElementById("qualitySlider");
  const qualityValue = document.getElementById("qualityValue");
  const codecH264 = document.getElementById("codecH264");
  const codecMode = document.getElementById("codecMode");
  const viewerFps = document.getElementById("viewerFps");
  const statusEl = document.getElementById("streamStatus");
  const canvas = document.getElementById("frameCanvas");
  const ctx = canvas.getContext("2d");
  const webrtcMode = document.getElementById("webrtcMode");
  const webrtcVideo = document.getElementById("webrtcVideo");
  let whepClient = null;
  let p2pClient = null;
  function getWebrtcMode() {
    return webrtcMode ? String(webrtcMode.value || "off") : "off";
  }
  function setWebrtcViewActive(active) {
    if (canvas) canvas.style.display = active ? "none" : "block";
    if (webrtcVideo) webrtcVideo.style.display = active ? "block" : "none";
  }

  clientLabel.textContent = clientId;

  let ws = null;
  let desiredStreaming = false;
  let streamState = "connecting";
  let renderCount = 0;
  let renderWindowStart = performance.now();
  let videoDecoder = null;
  let h264TimestampUs = 0;
  let availableDevices = [];
  let selectedDeviceIndex = 0;
  let hasRenderedFrame = false;
  let drawPending = false;

  const codecPrefKey = "webcamCodecPreferH264";
  let prefersH264 = typeof VideoDecoder === "function";

  const storedCodecPref = localStorage.getItem(codecPrefKey);
  if (storedCodecPref === "0") {
    prefersH264 = false;
  } else if (storedCodecPref === "1") {
    prefersH264 = typeof VideoDecoder === "function";
  }

  if (codecH264) {
    codecH264.checked = prefersH264;
    codecH264.disabled = typeof VideoDecoder !== "function";
  }

  function setCodecModeLabel(mode, detail) {
    if (!codecMode) return;
    const suffix = detail ? ` (${detail})` : "";
    codecMode.textContent = `Codec: ${String(mode || "auto").toUpperCase()}${suffix}`;
  }

  setCodecModeLabel(prefersH264 ? "h264" : "jpeg", "preferred");

  function updateQualityLabel(val) {
    if (qualityValue) {
      qualityValue.textContent = `${val}%`;
    }
  }

  function pushQuality(val) {
    const q = Number(val) || 90;
    const codec = prefersH264 ? "h264" : "jpeg";
    console.debug("webcam: pushQuality val=", val, "q=", q, "codec=", codec);
    setCodecModeLabel(codec, "requested");
    send("webcam_set_quality", { quality: q, codec });
  }

  function buildScreenshotFilename() {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return `webcam-${clientId}-${ts}.jpg`;
  }

  function downloadScreenshot() {
    if (!hasRenderedFrame) {
      setStreamState("error", "No frame available for screenshot");
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        setStreamState("error", "Failed to encode screenshot");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = buildScreenshotFilename();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/jpeg", 0.92);
  }

  function selectedDeviceMaxFps() {
    const selected = availableDevices.find((dev) => (Number(dev.index) || 0) === selectedDeviceIndex);
    const max = Number(selected?.maxFps) || 0;
    return max > 0 ? Math.min(120, max) : 120;
  }

  function applyFpsInputLimits() {
    const maxFps = selectedDeviceMaxFps();
    fpsInput.max = String(maxFps);
    const current = Number(fpsInput.value) || 30;
    if (current > maxFps) {
      fpsInput.value = String(maxFps);
    }
  }

  function applyFpsSettings() {
    if (streamState === "streaming" || streamState === "starting" || streamState === "stopping") {
      setStreamState("error", "Stop stream before changing FPS");
      return;
    }
    const maxFps = selectedDeviceMaxFps();
    const fps = Math.max(1, Math.min(maxFps, Number(fpsInput.value) || 30));
    if ((Number(fpsInput.value) || 30) > maxFps) {
      fpsInput.value = String(maxFps);
      setStreamState("idle", `FPS capped to camera max (${maxFps})`);
    }
    send("webcam_set_fps", { fps, useMax: false });
  }

  function requestCameraList() {
    send("webcam_list");
  }

  function renderCameraList(devices, selected) {
    availableDevices = Array.isArray(devices) ? devices : [];
    cameraSelect.innerHTML = "";
    if (!availableDevices.length) {
      const opt = document.createElement("option");
      opt.value = "0";
      opt.textContent = "No cameras detected";
      cameraSelect.appendChild(opt);
      cameraSelect.disabled = true;
      return;
    }
    cameraSelect.disabled = false;
    for (const dev of availableDevices) {
      const idx = Number(dev.index) || 0;
      const maxFps = Number(dev.maxFps) || 0;
      const opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = maxFps > 0
        ? `${dev.name || `Camera ${idx + 1}`} (max ${maxFps} FPS)`
        : (dev.name || `Camera ${idx + 1}`);
      cameraSelect.appendChild(opt);
    }
    selectedDeviceIndex = Number(selected) || 0;
    const selectedOpt = Array.from(cameraSelect.options).find((o) => Number(o.value) === selectedDeviceIndex);
    if (selectedOpt) {
      cameraSelect.value = selectedOpt.value;
    } else if (cameraSelect.options.length) {
      cameraSelect.value = cameraSelect.options[0].value;
    }
    selectedDeviceIndex = Number(cameraSelect.value) || 0;
    applyFpsInputLimits();
  }

  function isH264KeyFrame(data) {
    for (let i = 0; i + 4 < data.length; i++) {
      let startCodeLen = 0;
      if (data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x01) {
        startCodeLen = 3;
      } else if (
        i + 4 < data.length &&
        data[i] === 0x00 &&
        data[i + 1] === 0x00 &&
        data[i + 2] === 0x00 &&
        data[i + 3] === 0x01
      ) {
        startCodeLen = 4;
      }
      if (!startCodeLen) continue;
      const nalIndex = i + startCodeLen;
      if (nalIndex >= data.length) break;
      const nalType = data[nalIndex] & 0x1f;
      if (nalType === 5) {
        return true;
      }
      i = nalIndex;
    }
    return false;
  }

  function destroyVideoDecoder() {
    if (!videoDecoder) return;
    try {
      videoDecoder.close();
    } catch {}
    videoDecoder = null;
  }

  function ensureVideoDecoder() {
    if (videoDecoder) return true;
    if (typeof VideoDecoder !== "function") return false;
    try {
      videoDecoder = new VideoDecoder({
        output: (frame) => {
          hasRenderedFrame = true;
          const width = frame.displayWidth || frame.codedWidth || canvas.width;
          const height = frame.displayHeight || frame.codedHeight || canvas.height;
          if (width > 0 && height > 0 && (canvas.width !== width || canvas.height !== height)) {
            canvas.width = width;
            canvas.height = height;
          }
          try {
            ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          } finally {
            frame.close();
          }
        },
        error: (err) => {
          console.warn("webcam h264 decoder error", err);
        },
      });
      videoDecoder.configure({ codec: "avc1.42E01E", optimizeForLatency: true });
      h264TimestampUs = 0;
      return true;
    } catch (err) {
      console.warn("webcam h264 decoder unavailable", err);
      destroyVideoDecoder();
      return false;
    }
  }

  function setStreamState(state, text) {
    streamState = state;
    const icons = {
      connecting: '<i class="fa-solid fa-circle-notch fa-spin"></i>',
      starting: '<i class="fa-solid fa-circle-notch fa-spin"></i>',
      stopping: '<i class="fa-solid fa-circle-notch fa-spin"></i>',
      streaming: '<i class="fa-solid fa-circle text-emerald-400"></i>',
      idle: '<i class="fa-solid fa-circle text-slate-400"></i>',
      offline: '<i class="fa-solid fa-plug-circle-xmark text-rose-400"></i>',
      disconnected: '<i class="fa-solid fa-link-slash text-slate-400"></i>',
      error: '<i class="fa-solid fa-circle-exclamation text-rose-400"></i>',
    };
    const label = text ||
      (state === "streaming" ? "Streaming" :
        state === "starting" ? "Starting" :
          state === "stopping" ? "Stopping" :
            state === "offline" ? "Client offline" :
              state === "disconnected" ? "Disconnected" :
                state === "error" ? "Error" :
                  "Stopped");

    statusEl.innerHTML = `${icons[state] || icons.idle} <span>${label}</span>`;

    const wsOpen = ws && ws.readyState === WebSocket.OPEN;
    const streamLocked = streamState === "streaming" || streamState === "starting" || streamState === "stopping";
    startBtn.disabled = !wsOpen || streamState === "starting" || streamState === "streaming";
    stopBtn.disabled = !wsOpen || (streamState !== "starting" && streamState !== "streaming");
    screenshotBtn.disabled = !hasRenderedFrame;
    refreshCameras.disabled = !wsOpen;
    applyFps.disabled = !wsOpen || streamLocked;
    fpsInput.disabled = !wsOpen || streamLocked;

    if (state === "idle" || state === "offline" || state === "disconnected" || state === "error") {
      viewerFps.textContent = "--";
      renderCount = 0;
      renderWindowStart = performance.now();
    }
  }

  function updateViewerFps() {
    const now = performance.now();
    renderCount += 1;
    const elapsed = now - renderWindowStart;
    if (elapsed >= 1000) {
      viewerFps.textContent = String(Math.round((renderCount * 1000) / elapsed));
      renderCount = 0;
      renderWindowStart = now;
    }
  }

  async function drawJpeg(bytes) {
    if (drawPending) return;
    drawPending = true;
    try {
      const blob = new Blob([bytes], { type: "image/jpeg" });
      const bitmap = await createImageBitmap(blob);
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      hasRenderedFrame = true;
      bitmap.close();
      updateViewerFps();
      setStreamState("streaming", "Streaming");
    } finally {
      drawPending = false;
    }
  }

  function handleFrame(data) {
    const bytes = new Uint8Array(data);
    if (bytes.length < 8) return;
    if (bytes[0] !== 0x46 || bytes[1] !== 0x52 || bytes[2] !== 0x4d) return;
    const format = bytes[6];
    const payload = bytes.slice(8);
    if (!payload.length) return;
    if (format === 1) {
      drawJpeg(payload).catch((err) => {
        console.warn("webcam draw failed", err, "payloadBytes=", payload.length);
      });
      return;
    }
    if (format === 4) {
      if (!ensureVideoDecoder()) {
        setStreamState("error", "H264 decoder unavailable in browser");
        return;
      }
      try {
        const isKey = isH264KeyFrame(payload);
        const chunk = new EncodedVideoChunk({
          type: isKey ? "key" : "delta",
          timestamp: h264TimestampUs,
          data: payload,
        });
        h264TimestampUs += 66_666;
        videoDecoder.decode(chunk);
        updateViewerFps();
        setStreamState("streaming", "Streaming");
      } catch (err) {
        console.warn("webcam h264 decode failed", err, "payloadBytes=", payload.length);
      }
      return;
    }
    console.warn("webcam unsupported frame format", format, "payloadBytes=", payload.length);
  }

  function send(type, payload = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeMsgpack({ type, ...payload }));
  }

  async function startWhep(whepPath) {
    await stopAllWebrtc();
    if (!webrtcVideo) return;
    whepClient = new WhepClient({
      whepPath,
      videoEl: webrtcVideo,
      onState: (s) => {
        if (s === "connected") setStreamState("streaming", "Streaming (WebRTC Relayed)");
        else if (s === "failed" || s === "disconnected") setWebrtcViewActive(false);
      },
    });
    try {
      await whepClient.start();
      setWebrtcViewActive(true);
    } catch (err) {
      console.warn("webcam: WHEP start failed, falling back to canvas", err);
      setWebrtcViewActive(false);
      whepClient = null;
    }
  }

  async function startP2P() {
    await stopAllWebrtc();
    if (!webrtcVideo) return;
    p2pClient = new P2PClient({
      videoEl: webrtcVideo,
      send: (msg) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeMsgpack(msg));
      },
      onState: (s) => {
        if (s === "connected") setStreamState("streaming", "Streaming (WebRTC P2P)");
        else if (s === "failed" || s === "disconnected") setWebrtcViewActive(false);
      },
    });
    try {
      await p2pClient.start();
      setWebrtcViewActive(true);
    } catch (err) {
      console.warn("webcam: P2P start failed, falling back to canvas", err);
      setWebrtcViewActive(false);
      const c = p2pClient;
      p2pClient = null;
      if (c) { try { await c.stop(); } catch {} }
    }
  }

  async function stopAllWebrtc() {
    setWebrtcViewActive(false);
    const w = whepClient;
    whepClient = null;
    if (w) { try { await w.stop(); } catch {} }
    const p = p2pClient;
    p2pClient = null;
    if (p) { try { await p.stop(); } catch {} }
  }

  function handleControlMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "webrtc_ready" && typeof msg.whepPath === "string") {
      startWhep(msg.whepPath);
      return;
    }
    if (msg.type === "webrtc_p2p_answer" && typeof msg.sdp === "string") {
      if (p2pClient) p2pClient.onAnswer(msg.sdp);
      return;
    }
    if (msg.type === "webrtc_p2p_ice") {
      if (p2pClient) p2pClient.onRemoteCandidate(msg);
      return;
    }
    if (msg.type === "webcam_devices") {
      renderCameraList(msg.devices, msg.selected);
      return;
    }
    if (msg.type === "ready") {
      setStreamState("idle", "Ready");
      return;
    }
    if (msg.type === "status") {
      if (msg.status === "offline") {
        desiredStreaming = false;
        setStreamState("offline", msg.reason || "Client offline");
      } else if (msg.status === "connecting") {
        setStreamState("idle", "Ready");
      } else if (msg.status === "online") {
        setStreamState("idle", "Ready");
      }
    }
  }

  function connect() {
    const protocol = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(`${protocol}${location.host}/api/clients/${clientId}/webcam/ws`);
    ws.binaryType = "arraybuffer";
    setStreamState("connecting", "Connecting");

    ws.onopen = () => {
      requestCameraList();
      applyFpsSettings();
      pushQuality(qualitySlider ? qualitySlider.value : 90);
      if (desiredStreaming) {
        send("webcam_start");
        setStreamState("starting", "Starting");
      } else {
        setStreamState("idle", "Stopped");
      }
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        if (bytes.length >= 4 && bytes[0] === 0x46 && bytes[1] === 0x52 && bytes[2] === 0x4d) {
          handleFrame(event.data);
          return;
        }
      }

      const msg = decodeMsgpack(event.data);
      handleControlMessage(msg);
    };

    ws.onclose = () => {
      stopAllWebrtc();
      setStreamState("disconnected", "Disconnected");
      setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      stopAllWebrtc();
      setStreamState("error", "Connection error");
    };
  }

  startBtn.addEventListener("click", () => {
    desiredStreaming = true;
    applyFpsSettings();
    const mode = getWebrtcMode();
    if (mode === "relayed") {
      // Server replies with webrtc_ready; startWhep happens then.
      send("webcam_start", { webrtc: true });
    } else if (mode === "p2p") {
      send("webcam_start");
      startP2P();
    } else {
      send("webcam_start");
    }
    setStreamState("starting", "Starting");
  });

  stopBtn.addEventListener("click", () => {
    desiredStreaming = false;
    send("webcam_stop");
    stopAllWebrtc();
    setStreamState("stopping", "Stopping");
    setTimeout(() => {
      if (streamState === "stopping") {
        setStreamState("idle", "Stopped");
      }
    }, 300);
  });

  window.addEventListener("beforeunload", () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      send("webcam_stop");
    }
    destroyVideoDecoder();
  });

  refreshCameras.addEventListener("click", () => {
    requestCameraList();
  });

  cameraSelect.addEventListener("change", () => {
    const index = Number(cameraSelect.value) || 0;
    selectedDeviceIndex = index;
    applyFpsInputLimits();
    send("webcam_select", { index });
  });

  fpsInput.addEventListener("input", () => {
    const maxFps = selectedDeviceMaxFps();
    const val = Number(fpsInput.value);
    if (Number.isFinite(val) && val > maxFps) {
      fpsInput.value = String(maxFps);
    }
  });

  if (codecH264) {
    codecH264.addEventListener("change", function () {
      prefersH264 = !!codecH264.checked && typeof VideoDecoder === "function";
      localStorage.setItem(codecPrefKey, prefersH264 ? "1" : "0");
      if (!prefersH264) {
        destroyVideoDecoder();
      }
      if (qualitySlider) {
        pushQuality(qualitySlider.value);
      }
    });
  }

  if (qualitySlider) {
    updateQualityLabel(qualitySlider.value);
    qualitySlider.addEventListener("input", function () {
      updateQualityLabel(qualitySlider.value);
      pushQuality(qualitySlider.value);
    });
  }

  applyFps.addEventListener("click", () => {
    applyFpsSettings();
  });

  screenshotBtn.addEventListener("click", () => {
    downloadScreenshot();
  });

  connect();
})();
