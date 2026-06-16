import { encodeMsgpack, decodeMsgpack } from "./msgpack-helpers.js";
import { checkFeatureAccess } from "./feature-gate.js";
import { WhepClient } from "./whep.js";
import { P2PClient } from "./webrtc-p2p.js";
import { createSharedUiSettingsSaver, loadSharedUiSettings } from "./shared-ui-settings.js";

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
  const audioCtrl = document.getElementById("audioCtrl");
  const audioTransport = document.getElementById("audioTransport");
  const webrtcAudio = document.getElementById("webrtcAudio");
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
  let clientOs = "";
  let clientIsAdmin = false;
  let firewallWarningAcked = false;

  let prefersH264 = typeof VideoDecoder === "function";
  let savedCameraIndex = null;

  /* ── Remote system audio while viewing webcam ── */
  const AUDIO_SAMPLE_RATE = 16000;
  const AUDIO_PLAYBACK_FRAME = 512;
  const AUDIO_MAX_BUFFER_MS = 120;
  let audioWs = null;
  let audioPlayCtx = null;
  let audioProcessorNode = null;
  let audioChunks = [];
  let audioChunkOffset = 0;
  let audioWhep = null;
  let audioP2P = null;

  function getAudioTransport() {
    return audioTransport ? String(audioTransport.value || "off") : "off";
  }

  function audioResampleInt16ToFloat32(srcInt16, srcRate, dstRate) {
    if (!srcInt16 || srcInt16.length === 0) return new Float32Array(0);
    if (srcRate === dstRate) {
      const out = new Float32Array(srcInt16.length);
      for (let i = 0; i < srcInt16.length; i++) out[i] = srcInt16[i] / 0x8000;
      return out;
    }
    const outLength = Math.max(1, Math.round((srcInt16.length * dstRate) / srcRate));
    const out = new Float32Array(outLength);
    const step = srcRate / dstRate;
    for (let i = 0; i < outLength; i++) {
      const srcPos = i * step;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, srcInt16.length - 1);
      const frac = srcPos - i0;
      out[i] = (srcInt16[i0] * (1 - frac) + srcInt16[i1] * frac) / 0x8000;
    }
    return out;
  }

  function initAudioPlayback() {
    if (!audioPlayCtx) {
      audioPlayCtx = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE, latencyHint: "interactive" });
    }
    if (!audioProcessorNode) {
      audioProcessorNode = audioPlayCtx.createScriptProcessor(AUDIO_PLAYBACK_FRAME, 1, 1);
      audioProcessorNode.onaudioprocess = function (event) {
        const out = event.outputBuffer.getChannelData(0);
        out.fill(0);
        let writeIndex = 0;
        while (writeIndex < out.length && audioChunks.length > 0) {
          const head = audioChunks[0];
          const remaining = head.length - audioChunkOffset;
          if (remaining <= 0) { audioChunks.shift(); audioChunkOffset = 0; continue; }
          const take = Math.min(out.length - writeIndex, remaining);
          out.set(head.subarray(audioChunkOffset, audioChunkOffset + take), writeIndex);
          writeIndex += take;
          audioChunkOffset += take;
          if (audioChunkOffset >= head.length) { audioChunks.shift(); audioChunkOffset = 0; }
        }
      };
      audioProcessorNode.connect(audioPlayCtx.destination);
    }
  }

  function appendAudioPcm(binary) {
    if (!audioPlayCtx) initAudioPlayback();
    const samples = Math.floor(binary.byteLength / 2);
    if (samples <= 0) return;
    const src = new Int16Array(binary.buffer, binary.byteOffset, samples);
    const chunk = audioResampleInt16ToFloat32(src, AUDIO_SAMPLE_RATE, audioPlayCtx?.sampleRate || AUDIO_SAMPLE_RATE);
    if (chunk.length === 0) return;
    audioChunks.push(chunk);
    let buffered = -audioChunkOffset;
    for (const c of audioChunks) buffered += c.length;
    const rate = audioPlayCtx?.sampleRate || AUDIO_SAMPLE_RATE;
    const max = Math.max(AUDIO_PLAYBACK_FRAME, Math.round(rate * (AUDIO_MAX_BUFFER_MS / 1000)));
    while (buffered > max && audioChunks.length > 0) {
      const dropped = audioChunks.shift();
      buffered -= dropped?.length || 0;
      audioChunkOffset = 0;
    }
  }

  async function stopAudioWebrtc() {
    const w = audioWhep;
    audioWhep = null;
    if (w) { try { await w.stop(); } catch {} }
    const p = audioP2P;
    audioP2P = null;
    if (p) { try { await p.stop(); } catch {} }
  }

  async function startAudioWhep(whepPath) {
    await stopAudioWebrtc();
    audioWhep = new WhepClient({
      whepPath,
      audioEl: webrtcAudio,
      onState: (s) => console.debug("webcam-audio-webrtc[Relayed]: state", s),
    });
    try {
      await audioWhep.start();
    } catch (err) {
      console.warn("webcam audio: WHEP start failed", err);
      audioWhep = null;
    }
  }

  function startAudioP2P() {
    if (!audioWs || audioWs.readyState !== WebSocket.OPEN) return;
    audioP2P = new P2PClient({
      audioEl: webrtcAudio,
      send: (msg) => {
        if (audioWs && audioWs.readyState === WebSocket.OPEN) {
          audioWs.send(JSON.stringify(msg));
        }
      },
      onState: (s) => console.debug("webcam-audio-webrtc[P2P]: state", s),
    });
    audioP2P.start().catch((err) => {
      console.warn("webcam audio: P2P start failed", err);
      audioP2P = null;
    });
  }

  function cleanupAudio(uncheckBox) {
    if (audioProcessorNode) {
      audioProcessorNode.disconnect();
      audioProcessorNode.onaudioprocess = null;
      audioProcessorNode = null;
    }
    if (audioPlayCtx) {
      audioPlayCtx.close().catch(function () {});
      audioPlayCtx = null;
    }
    audioChunks = [];
    audioChunkOffset = 0;
    audioWs = null;
    if (uncheckBox && audioCtrl) audioCtrl.checked = false;
  }

  function connectAudio() {
    if (audioWs && audioWs.readyState === WebSocket.OPEN) return;
    const mode = getAudioTransport();
    if (mode === "off") {
      initAudioPlayback();
      if (audioPlayCtx?.state === "suspended") audioPlayCtx.resume();
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsAudio = new WebSocket(`${proto}//${location.host}/api/clients/${encodeURIComponent(clientId)}/desktop-audio/ws`);
    audioWs = wsAudio;
    wsAudio.binaryType = "arraybuffer";
    wsAudio.onopen = function () {
      const start = { type: "start", source: "system" };
      if (mode === "relayed") start.webrtc = true;
      try { wsAudio.send(JSON.stringify(start)); } catch (err) {
        console.warn("webcam audio: send start failed", err);
        return;
      }
      if (mode === "p2p") startAudioP2P();
    };
    wsAudio.onmessage = function (ev) {
      if (typeof ev.data === "string") {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg.type !== "string") return;
        if (msg.type === "webrtc_ready" && typeof msg.whepPath === "string") {
          startAudioWhep(msg.whepPath);
          return;
        }
        if (msg.type === "webrtc_p2p_answer" && typeof msg.sdp === "string") {
          if (audioP2P) audioP2P.onAnswer(msg.sdp);
          return;
        }
        if (msg.type === "webrtc_p2p_ice") {
          if (audioP2P) audioP2P.onRemoteCandidate(msg);
          return;
        }
        return;
      }
      const bytes = new Uint8Array(ev.data);
      if (mode === "off" && bytes.byteLength > 1) appendAudioPcm(bytes);
    };
    wsAudio.onclose = function () {
      if (audioWs === wsAudio) {
        stopAudioWebrtc();
        cleanupAudio(false);
      }
    };
    wsAudio.onerror = function () {};
  }

  function disconnectAudio(uncheckBox = true) {
    if (audioWs) {
      try { audioWs.send(JSON.stringify({ type: "stop" })); } catch {}
      try { audioWs.close(); } catch {}
      audioWs = null;
    }
    stopAudioWebrtc();
    cleanupAudio(uncheckBox);
  }

  function setSelectValue(select, value) {
    if (!select || value === undefined || value === null) return false;
    const normalized = String(value);
    const exists = Array.from(select.options || []).some((opt) => opt.value === normalized);
    if (!exists) return false;
    select.value = normalized;
    return true;
  }

  function applySavedCamera() {
    if (savedCameraIndex === null || savedCameraIndex === undefined) return false;
    if (!setSelectValue(cameraSelect, savedCameraIndex)) return false;
    selectedDeviceIndex = Number(cameraSelect.value) || 0;
    applyFpsInputLimits();
    return true;
  }

  function applySharedSettings(settings) {
    if (!settings || typeof settings !== "object") return;
    if (Number.isFinite(Number(settings.camera))) {
      savedCameraIndex = Number(settings.camera);
    }
    if (fpsInput && settings.fps !== undefined) fpsInput.value = String(settings.fps);
    if (qualitySlider && settings.quality !== undefined) qualitySlider.value = String(settings.quality);
    setSelectValue(webrtcMode, settings.webrtcMode);
    setSelectValue(audioTransport, settings.audioTransport);
    if (audioCtrl && typeof settings.audio === "boolean") audioCtrl.checked = settings.audio;
    if (typeof settings.preferH264 === "boolean") {
      prefersH264 = settings.preferH264 && typeof VideoDecoder === "function";
    }
    applySavedCamera();
  }

  function readSharedSettings() {
    return {
      camera: Number(cameraSelect?.value ?? savedCameraIndex ?? 0),
      fps: Number(fpsInput?.value || 30),
      quality: Number(qualitySlider?.value || 90),
      preferH264: !!prefersH264,
      webrtcMode: getWebrtcMode(),
      audio: !!audioCtrl?.checked,
      audioTransport: getAudioTransport(),
    };
  }

  applySharedSettings(await loadSharedUiSettings("webcam"));
  const sharedSettingsSaver = createSharedUiSettingsSaver("webcam", readSharedSettings);

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
    selectedDeviceIndex = savedCameraIndex !== null && savedCameraIndex !== undefined
      ? Number(savedCameraIndex) || 0
      : Number(selected) || 0;
    const selectedOpt = Array.from(cameraSelect.options).find((o) => Number(o.value) === selectedDeviceIndex);
    if (selectedOpt) {
      cameraSelect.value = selectedOpt.value;
    } else if (cameraSelect.options.length) {
      cameraSelect.value = cameraSelect.options[0].value;
    }
    selectedDeviceIndex = Number(cameraSelect.value) || 0;
    applyFpsInputLimits();
    if (selectedDeviceIndex !== Number(selected || 0) && ws && ws.readyState === WebSocket.OPEN) {
      send("webcam_select", { index: selectedDeviceIndex });
    }
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
      if (desiredStreaming) setStreamState("streaming", "Streaming");
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
        if (desiredStreaming) setStreamState("streaming", "Streaming");
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
      if (msg.os) clientOs = String(msg.os).toLowerCase();
      if (msg.isAdmin !== undefined) clientIsAdmin = !!msg.isAdmin;
      setStreamState("idle", "Ready");
      return;
    }
    if (msg.type === "status") {
      if (msg.status === "offline") {
        desiredStreaming = false;
        setStreamState("offline", msg.reason || "Client offline");
      } else if (msg.status === "starting") {
        if (desiredStreaming && streamState !== "streaming") {
          setStreamState("starting", "Starting");
        }
      } else if (msg.status === "stopped") {
        desiredStreaming = false;
        setStreamState("idle", "Stopped");
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
      if (savedCameraIndex !== null && savedCameraIndex !== undefined) {
        selectedDeviceIndex = Number(savedCameraIndex) || 0;
        send("webcam_select", { index: selectedDeviceIndex });
      }
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

  function needsWebrtcFirewallWarning(mode) {
    if (firewallWarningAcked) return false;
    if (mode !== "relayed" && mode !== "p2p") return false;
    const isWindows = clientOs.includes("windows") || clientOs.includes("win");
    return isWindows && !clientIsAdmin;
  }

  startBtn.addEventListener("click", () => {
    const mode = getWebrtcMode();
    if (needsWebrtcFirewallWarning(mode)) {
      if (!confirm("This agent is not elevated. Starting WebRTC will trigger a Windows Defender Firewall prompt on the target machine.\n\nContinue?")) {
        return;
      }
      firewallWarningAcked = true;
    }
    desiredStreaming = true;
    applyFpsSettings();
    if (mode === "relayed") {
      // Server replies with webrtc_ready; startWhep happens then.
      send("webcam_start", { webrtc: true });
    } else if (mode === "p2p") {
      send("webcam_start");
      startP2P();
    } else {
      send("webcam_start");
    }
    if (audioCtrl && audioCtrl.checked) {
      connectAudio();
    }
    setStreamState("starting", "Starting");
  });

  stopBtn.addEventListener("click", () => {
    desiredStreaming = false;
    send("webcam_stop");
    stopAllWebrtc();
    disconnectAudio();
    setStreamState("idle", "Stopped");
  });

  function stopOnExit() {
    sharedSettingsSaver.saveNow();
    if (ws && ws.readyState === WebSocket.OPEN) {
      send("webcam_stop");
    }
    disconnectAudio();
    destroyVideoDecoder();
  }
  window.addEventListener("beforeunload", stopOnExit);
  window.addEventListener("pagehide", stopOnExit);

  refreshCameras.addEventListener("click", () => {
    requestCameraList();
  });

  cameraSelect.addEventListener("change", () => {
    const index = Number(cameraSelect.value) || 0;
    savedCameraIndex = index;
    selectedDeviceIndex = index;
    applyFpsInputLimits();
    send("webcam_select", { index });
    sharedSettingsSaver.scheduleSave();
  });

  fpsInput.addEventListener("input", () => {
    const maxFps = selectedDeviceMaxFps();
    const val = Number(fpsInput.value);
    if (Number.isFinite(val) && val > maxFps) {
      fpsInput.value = String(maxFps);
    }
    sharedSettingsSaver.scheduleSave();
  });

  if (codecH264) {
    codecH264.addEventListener("change", function () {
      prefersH264 = !!codecH264.checked && typeof VideoDecoder === "function";
      if (!prefersH264) {
        destroyVideoDecoder();
      }
      if (qualitySlider) {
        pushQuality(qualitySlider.value);
      }
      sharedSettingsSaver.scheduleSave();
    });
  }

  if (qualitySlider) {
    updateQualityLabel(qualitySlider.value);
    qualitySlider.addEventListener("input", function () {
      updateQualityLabel(qualitySlider.value);
      pushQuality(qualitySlider.value);
      sharedSettingsSaver.scheduleSave();
    });
  }

  applyFps.addEventListener("click", () => {
    applyFpsSettings();
    sharedSettingsSaver.scheduleSave();
  });

  if (webrtcMode) {
    webrtcMode.addEventListener("change", () => {
      sharedSettingsSaver.scheduleSave();
    });
  }

  if (audioCtrl) {
    audioCtrl.addEventListener("change", () => {
      if (audioCtrl.checked) {
        connectAudio();
      } else {
        disconnectAudio();
      }
      sharedSettingsSaver.scheduleSave();
    });
  }

  if (audioTransport) {
    audioTransport.addEventListener("change", () => {
      if (audioCtrl && audioCtrl.checked) {
        disconnectAudio(false);
        connectAudio();
      }
      sharedSettingsSaver.scheduleSave();
    });
  }

  screenshotBtn.addEventListener("click", () => {
    downloadScreenshot();
  });

  connect();
})();
