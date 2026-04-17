import { encodeMsgpack, decodeMsgpack } from "./msgpack-helpers.js";
import { checkFeatureAccess } from "./feature-gate.js";

(async function () {
  const clientId = new URLSearchParams(location.search).get("clientId");
  if (!clientId) {
    alert("Missing clientId");
    return;
  }

  const allowed = await checkFeatureAccess("remote_desktop", clientId);
  if (!allowed) return;

  const clientLabel = document.getElementById("clientLabel");
  clientLabel.textContent = clientId;

  const ws = new WebSocket(
    (location.protocol === "https:" ? "wss://" : "ws://") +
      location.host +
      "/api/clients/" +
      clientId +
      "/rd/ws",
  );
  const displaySelect = document.getElementById("displaySelect");
  const refreshBtn = document.getElementById("refreshDisplays");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const mouseCtrl = document.getElementById("mouseCtrl");
  const kbdCtrl = document.getElementById("kbdCtrl");
  const cursorCtrl = document.getElementById("cursorCtrl");
  const duplicationCtrl = document.getElementById("duplicationCtrl");
  const resolutionSelect = document.getElementById("resolutionSelect");
  const smoothingSlider = document.getElementById("smoothingSlider");
  const smoothingValue = document.getElementById("smoothingValue");
  const qualitySlider = document.getElementById("qualitySlider");
  const qualityValue = document.getElementById("qualityValue");
  const codecH264 = document.getElementById("codecH264");
  const codecMode = document.getElementById("codecMode");
  const canvas = document.getElementById("frameCanvas");
  const canvasContainer = document.getElementById("canvasContainer");
  const ctx = canvas.getContext("2d");
  const agentFps = document.getElementById("agentFps");
  const viewerFps = document.getElementById("viewerFps");
  const inputLatency = document.getElementById("inputLatency");
  const statusEl = document.getElementById("streamStatus");
  const clipboardSyncCtrl = document.getElementById("clipboardSyncCtrl");
  const audioCtrl = document.getElementById("audioCtrl");
  ws.binaryType = "arraybuffer";

  let activeClientId = clientId;
  let renderCount = 0;
  let renderWindowStart = performance.now();
  let lastFrameAt = 0;
  let desiredStreaming = false;
  let streamState = "connecting";
  let frameWatchTimer = null;
  let offlineTimer = null;
  let frameWidth = 0;
  let frameHeight = 0;
  let latencyAvg = null;
  let smoothingPct = 20;
  let smoothPoint = null;
  let pendingMove = null;
  let moveTimer = null;
  let frameDecodeBusy = false;
  let pendingFrame = null;
  let videoDecoder = null;
  let h264TimestampUs = 0;
  const codecPrefKey = "rdCodecPreferH264";
  let prefersH264 = typeof VideoDecoder === "function";
  let h264LowFpsStreak = 0;
  let h264FirstFrameAt = 0;
  let h264FramesSeen = 0;
  let h264KeyframeErrorStreak = 0;
  let h264RecoveryAttempts = 0;
  let h264LastDecodeWarnAt = 0;
  const H264_LOW_FPS_THRESHOLD = 6;
  const H264_FALLBACK_WARMUP_MS = 10000;
  const H264_MIN_FRAMES_BEFORE_FALLBACK = 120;
  const H264_LOW_FPS_STREAK_LIMIT = 120;
  const H264_KEYFRAME_ERROR_RESTART_THRESHOLD = 24;
  const H264_MAX_RECOVERY_ATTEMPTS = 1;
  const H264_DECODE_WARN_THROTTLE_MS = 2000;
  const mouseMoveIntervalMs = 33;
  const inputBackpressureBytes = 256 * 1024;
  let lastMoveSentAt = 0;

  let clipboardSyncTimer = null;
  let lastClipboardText = "";
  let clipboardSyncActive = false;
  let elevationPending = false;

  function resetH264RuntimeState() {
    h264TimestampUs = 0;
    h264LowFpsStreak = 0;
    h264FirstFrameAt = 0;
    h264FramesSeen = 0;
    h264KeyframeErrorStreak = 0;
  }

  /* ── Remote Desktop Audio (system audio from client) ── */
  const AUDIO_SAMPLE_RATE = 16000;
  const AUDIO_PLAYBACK_FRAME = 512;
  const AUDIO_MAX_BUFFER_MS = 120;
  let audioWs = null;
  let audioPlayCtx = null;
  let audioProcessorNode = null;
  let audioChunks = [];
  let audioChunkOffset = 0;

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

  function connectAudio() {
    if (audioWs && audioWs.readyState === WebSocket.OPEN) return;
    // Create AudioContext in click/change handler so the browser trusts the user gesture.
    initAudioPlayback();
    if (audioPlayCtx?.state === "suspended") audioPlayCtx.resume();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    audioWs = new WebSocket(proto + "//" + location.host + "/api/clients/" + encodeURIComponent(clientId) + "/desktop-audio/ws");
    audioWs.binaryType = "arraybuffer";
    audioWs.onopen = function () {
      audioWs.send(JSON.stringify({ type: "start", source: "system" }));
    };
    audioWs.onmessage = function (ev) {
      if (typeof ev.data === "string") return;
      const bytes = new Uint8Array(ev.data);
      if (bytes.byteLength > 1) appendAudioPcm(bytes);
    };
    audioWs.onclose = function () { cleanupAudio(false); };
    audioWs.onerror = function () {};
  }

  function disconnectAudio() {
    if (audioWs) {
      try { audioWs.send(JSON.stringify({ type: "stop" })); } catch {}
      try { audioWs.close(); } catch {}
      audioWs = null;
    }
    cleanupAudio(true);
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

  function resetH264SessionState() {
    resetH264RuntimeState();
    h264RecoveryAttempts = 0;
    h264LastDecodeWarnAt = 0;
  }

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
        streaming: '<i class="fa-solid fa-circle text-emerald-400"></i>',
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
        streaming: "bg-emerald-900/40 text-emerald-100 border-emerald-700/70",
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
    const wsOpen = ws.readyState === WebSocket.OPEN;
    const isStarting = streamState === "starting";
    const isStreaming = streamState === "streaming";
    const isStopping = streamState === "stopping";
    const isStalled = streamState === "stalled";
    const isBlocked = streamState === "offline" || streamState === "disconnected" || streamState === "error";

    if (startBtn) {
      startBtn.disabled = !wsOpen || isStarting || isStreaming || isStopping || isBlocked;
    }
    if (stopBtn) {
      stopBtn.disabled = !wsOpen || (!isStarting && !isStreaming && !isStopping && !isStalled);
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

  function updateLatency(ms) {
    if (ms < 0 || !Number.isFinite(ms)) return;
    latencyAvg = latencyAvg == null ? ms : latencyAvg * 0.8 + ms * 0.2;
    if (inputLatency) {
      inputLatency.textContent = `${Math.round(latencyAvg)} ms`;
    }
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
        if (elevationPending) return;
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
    if (msg.status === "permissions_denied") {
      clearOfflineTimer();
      desiredStreaming = false;
      const missing = Array.isArray(msg.missing) ? msg.missing : [];
      const labels = {
        screenRecording: "Screen Recording",
        accessibility: "Accessibility",
        fullDiskAccess: "Full Disk Access",
      };
      const list = missing.map(k => labels[k] || k).join(", ");
      setStreamState("error", `macOS permissions required: ${list}`);
      showElevateOffer(missing);
      return;
    }
    if (msg.status === "connecting") {
      clearOfflineTimer();
      setStreamState("connecting", "Connecting");
      return;
    }
    if (msg.status === "online") {
      clearOfflineTimer();
      if (elevationPending) {
        elevationPending = false;
        desiredStreaming = true;
      }
      if (desiredStreaming) {
        setStreamState("starting", "Reconnecting");
        if (displaySelect && displaySelect.value !== undefined) {
          sendCmd("desktop_select_display", {
            display: parseInt(displaySelect.value, 10) || 0,
          });
        }
        sendCmd("desktop_start", {});
        pushInputToggles();
        pushCaptureToggles();
        if (qualitySlider) pushQuality(qualitySlider.value);
        pushResolution();
      } else {
        setStreamState("idle", "Stopped");
      }
    }
  }

  function showElevateOffer(missing) {
    // Remove previous elevate banner if any
    const prev = document.getElementById("rdElevateBanner");
    if (prev) prev.remove();

    const banner = document.createElement("div");
    banner.id = "rdElevateBanner";
    banner.className = "flex flex-col items-center gap-3 p-4 rounded-lg border border-amber-700/70 bg-amber-900/30 text-amber-100 text-sm";

    const labels = {
      screenRecording: "Screen Recording",
      accessibility: "Accessibility",
      fullDiskAccess: "Full Disk Access",
    };
    const list = missing.map(k => labels[k] || k).join(", ");

    banner.innerHTML = `
      <div class="flex items-center gap-2">
        <i class="fa-solid fa-triangle-exclamation text-amber-400"></i>
        <span><strong>macOS permissions missing:</strong> ${list}</span>
      </div>
      <div class="text-xs text-amber-300/80">
        The client needs elevated privileges to grant these permissions. Enter the user's password to elevate.
      </div>
      <div class="flex items-center gap-2">
        <input id="rdElevatePwd" type="password" placeholder="User password" autocomplete="off"
          class="px-3 py-1.5 rounded bg-slate-800 border border-slate-600 text-slate-100 text-sm focus:outline-none focus:border-amber-500" />
        <button id="rdElevateBtn" class="button primary text-sm px-4 py-1.5">
          <i class="fa-solid fa-bolt"></i> Elevate
        </button>
        <button id="rdElevateDismiss" class="button ghost text-sm px-3 py-1.5">Dismiss</button>
      </div>
      <div id="rdElevateStatus" class="text-xs text-slate-400 hidden"></div>
    `;

    // Insert banner above the canvas area
    if (canvasContainer && canvasContainer.parentNode) {
      canvasContainer.parentNode.insertBefore(banner, canvasContainer);
    }

    const elevateBtn = document.getElementById("rdElevateBtn");
    const pwdInput = document.getElementById("rdElevatePwd");
    const statusDiv = document.getElementById("rdElevateStatus");
    const dismissBtn = document.getElementById("rdElevateDismiss");

    if (dismissBtn) {
      dismissBtn.addEventListener("click", () => banner.remove());
    }

    if (elevateBtn && pwdInput) {
      elevateBtn.addEventListener("click", async () => {
        const password = pwdInput.value.trim();
        if (!password) {
          pwdInput.focus();
          return;
        }
        elevateBtn.disabled = true;
        elevateBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Elevating...';
        if (statusDiv) {
          statusDiv.classList.remove("hidden");
          statusDiv.textContent = "Sending elevation request...";
        }
        try {
          const res = await fetch(`/api/clients/${encodeURIComponent(activeClientId)}/command`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "elevate", password }),
          });
          const data = await res.json();
          if (data.ok) {
            if (statusDiv) {
              statusDiv.textContent = "Elevation successful — client is restarting with elevated permissions. It will reconnect shortly.";
              statusDiv.className = "text-xs text-emerald-400";
            }
            elevateBtn.textContent = "Done";
            elevationPending = true;
            desiredStreaming = true;
          } else {
            if (statusDiv) {
              statusDiv.textContent = `Elevation failed: ${data.message || "Unknown error"}`;
              statusDiv.className = "text-xs text-rose-400";
            }
            elevateBtn.disabled = false;
            elevateBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Retry';
          }
        } catch (err) {
          if (statusDiv) {
            statusDiv.textContent = `Request failed: ${err.message}`;
            statusDiv.className = "text-xs text-rose-400";
          }
          elevateBtn.disabled = false;
          elevateBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Retry';
        }
      });
    }
  }

  function sendCmd(type, payload) {
    if (!activeClientId) {
      console.warn("No active client selected");
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const msg = { type, ...payload };
    console.debug("rd: send", msg);
    ws.send(encodeMsgpack(msg));
  }

  let monitors = 1;

  function populateDisplays(count, monitorInfo) {
    displaySelect.innerHTML = "";
    const infoList = Array.isArray(monitorInfo) ? monitorInfo : null;
    monitors = (infoList && infoList.length) ? infoList.length : (count || 1);
    for (let i = 0; i < monitors; i++) {
      const opt = document.createElement("option");
      opt.value = i;
      const info = infoList && infoList[i];
      const w = info && Number(info.width);
      const h = info && Number(info.height);
      const sizeLabel = w > 0 && h > 0 ? ` (${w}x${h})` : "";
      opt.textContent = "Display " + (i + 1) + sizeLabel;
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
      if (client) {
        populateDisplays(client.monitors, client.monitorInfo);
      }
      if (duplicationCtrl) {
        const os = (client?.os || "").toLowerCase();
        const isWindows = os.includes("windows") || os.includes("win");
        duplicationCtrl.disabled = !isWindows;
        if (!isWindows) {
          duplicationCtrl.checked = false;
        }
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

  function updateSmoothingLabel(val) {
    if (smoothingValue) {
      smoothingValue.textContent = `${val}%`;
    }
  }

  function pushQuality(val) {
    const q = Number(val) || 90;
    const codec = q >= 100 ? "raw" : (prefersH264 ? "h264" : "jpeg");
    console.debug("rd: pushQuality val=", val, "q=", q, "codec=", codec);
    setCodecModeLabel(codec, "requested");
    sendCmd("desktop_set_quality", { quality: q, codec });
  }

  if (codecH264) {
    codecH264.addEventListener("change", function () {
      resetH264SessionState();
      prefersH264 = !!codecH264.checked && typeof VideoDecoder === "function";
      localStorage.setItem(codecPrefKey, prefersH264 ? "1" : "0");
      if (!prefersH264) {
        destroyVideoDecoder();
        h264LowFpsStreak = 0;
      }
      if (qualitySlider) {
        pushQuality(qualitySlider.value);
      }
    });
  }

  function pushResolution() {
    if (resolutionSelect) {
      const maxHeight = parseInt(resolutionSelect.value, 10);
      console.debug("rd: pushResolution maxHeight=", maxHeight);
      sendCmd("desktop_set_resolution", { maxHeight: maxHeight });
    }
  }

  if (resolutionSelect) {
    resolutionSelect.addEventListener("change", function () {
      pushResolution();
    });
  }

  displaySelect.addEventListener("change", function () {
    console.debug("rd: select display", displaySelect.value);
    sendCmd("desktop_select_display", {
      display: parseInt(displaySelect.value, 10),
    });
  });

  startBtn.addEventListener("click", function () {
    if (displaySelect && displaySelect.value !== undefined) {
      sendCmd("desktop_select_display", {
        display: parseInt(displaySelect.value, 10) || 0,
      });
    }
    if (qualitySlider) {
      pushQuality(qualitySlider.value);
    }
    pushResolution();
    desiredStreaming = true;
    lastFrameAt = 0;
    resetH264SessionState();
    setStreamState("starting", "Starting stream");
    sendCmd("desktop_start", {});
  });
  stopBtn.addEventListener("click", function () {
    desiredStreaming = false;
    setStreamState("stopping", "Stopping stream");
    sendCmd("desktop_stop", {});
    disconnectAudio();
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
  if (mouseCtrl) {
    mouseCtrl.checked = false;
  }
  if (kbdCtrl) {
    kbdCtrl.checked = false;
  }
  if (duplicationCtrl) {
    duplicationCtrl.checked = false;
  }

  function pushInputToggles() {
    if (mouseCtrl) {
      sendCmd("desktop_enable_mouse", { enabled: !!mouseCtrl.checked });
    }
    if (kbdCtrl) {
      sendCmd("desktop_enable_keyboard", { enabled: !!kbdCtrl.checked });
    }
  }

  function pushCaptureToggles() {
    if (cursorCtrl) {
      sendCmd("desktop_enable_cursor", { enabled: cursorCtrl.checked });
    }
    if (duplicationCtrl && !duplicationCtrl.disabled) {
      sendCmd("desktop_set_duplication", { enabled: !!duplicationCtrl.checked });
    }
  }

  mouseCtrl.addEventListener("change", function () {
    pushInputToggles();
  });
  kbdCtrl.addEventListener("change", function () {
    if (kbdCtrl.checked) {
      canvas.focus({ preventScroll: true });
    }
    pushInputToggles();
  });
  cursorCtrl.addEventListener("change", function () {
    pushCaptureToggles();
  });
  if (duplicationCtrl) {
    duplicationCtrl.addEventListener("change", function () {
      pushCaptureToggles();
    });
  }
  if (audioCtrl) {
    audioCtrl.addEventListener("change", function () {
      if (audioCtrl.checked) {
        connectAudio();
      } else {
        disconnectAudio();
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

  if (smoothingSlider) {
    updateSmoothingLabel(smoothingSlider.value);
    smoothingSlider.addEventListener("input", function () {
      smoothingPct = Number(smoothingSlider.value) || 0;
      updateSmoothingLabel(smoothingSlider.value);
    });
  }

  function isFramePacket(buf) {
    return buf.length >= 8 && buf[0] === 0x46 && buf[1] === 0x52 && buf[2] === 0x4d;
  }

  function markFrameReceived() {
    lastFrameAt = performance.now();
    clearOfflineTimer();
    if (streamState !== "streaming" && desiredStreaming) {
      setStreamState("streaming", "Streaming");
    }
  }

  function drawJpegFallback(blob, target) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = function () {
        if (target) {
          ctx.drawImage(img, target.x, target.y, target.w, target.h);
        } else {
          frameWidth = img.width || frameWidth;
          frameHeight = img.height || frameHeight;
          canvas.width = img.width;
          canvas.height = img.height;
          ctx.drawImage(img, 0, 0);
        }
        URL.revokeObjectURL(url);
        resolve(true);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(false);
      };
      img.src = url;
    });
  }

  async function drawJpegSlice(slice, target) {
    const blob = new Blob([slice], { type: "image/jpeg" });
    try {
      const bitmap = await createImageBitmap(blob);
      if (target) {
        ctx.drawImage(bitmap, target.x, target.y, target.w, target.h);
      } else {
        frameWidth = bitmap.width || frameWidth;
        frameHeight = bitmap.height || frameHeight;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        ctx.drawImage(bitmap, 0, 0);
      }
      bitmap.close();
      return true;
    } catch {
      return drawJpegFallback(blob, target);
    }
  }

  function destroyVideoDecoder() {
    if (!videoDecoder) return;
    try {
      videoDecoder.close();
    } catch {
      // Ignore close errors when decoder is already shutting down.
    }
    videoDecoder = null;
    resetH264RuntimeState();
  }

  function normalizeFallbackReason(reason) {
    if (!reason) return "unspecified";
    if (typeof reason === "string") return reason;
    if (reason instanceof Error) return reason.message || String(reason);
    if (typeof reason === "object") {
      if (typeof reason.message === "string" && reason.message) {
        return reason.message;
      }
      if (typeof reason.name === "string" && reason.name) {
        return reason.name;
      }
      try {
        return JSON.stringify(reason);
      } catch {
        return String(reason);
      }
    }
    return String(reason);
  }

  function fallbackToJpegCodec(reason) {
    if (!prefersH264) return;
    const reasonText = normalizeFallbackReason(reason);
    prefersH264 = false;
    destroyVideoDecoder();
    if (codecH264) codecH264.checked = false;
    localStorage.setItem(codecPrefKey, "0");
    console.warn("rd: falling back to jpeg codec", reasonText);
    const q = Number(qualitySlider?.value) || 90;
    setCodecModeLabel("jpeg", "fallback");
    if (ws.readyState === WebSocket.OPEN) {
      sendCmd("desktop_set_quality", {
        quality: q,
        codec: "jpeg",
        source: "viewer_fallback",
        reason: reasonText,
      });
    }
  }

  function tryRecoverH264Stream(reason = "h264_decode_error") {
    if (!prefersH264 || !activeClientId) return false;
    if (streamState !== "streaming" && streamState !== "stalled" && streamState !== "starting") {
      return false;
    }
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (h264RecoveryAttempts >= H264_MAX_RECOVERY_ATTEMPTS) return false;

    h264RecoveryAttempts += 1;
    h264KeyframeErrorStreak = 0;

    console.warn("rd: h264 decode stuck waiting for keyframe; auto-restarting stream once", {
      reason,
      attempt: h264RecoveryAttempts
    });

    sendCmd("desktop_stop", {
      source: "rd_viewer",
      reason: "h264_recovery_stop",
    });

    setTimeout(() => {
      if (!prefersH264 || !activeClientId || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      resetH264RuntimeState();
      sendCmd("desktop_start", {
        source: "rd_viewer",
        reason: "h264_recovery_restart",
      });
      const q = Number(qualitySlider?.value) || 90;
      sendCmd("desktop_set_quality", {
        quality: q,
        codec: "h264",
        source: "rd_viewer",
        reason: "h264_recovery_quality_push",
      });
    }, 450);

    return true;
  }

  function isKeyframeRequiredError(reason) {
    const text = normalizeFallbackReason(reason).toLowerCase();
    return text.includes("key frame is required") || text.includes("keyframe is required");
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

  function ensureVideoDecoder() {
    if (videoDecoder) {
      return true;
    }
    if (typeof VideoDecoder !== "function") {
      return false;
    }
    try {
      videoDecoder = new VideoDecoder({
        output: (frame) => {
          const width = frame.displayWidth || frame.codedWidth || frameWidth;
          const height = frame.displayHeight || frame.codedHeight || frameHeight;
          if (width > 0 && height > 0 && (canvas.width !== width || canvas.height !== height)) {
            canvas.width = width;
            canvas.height = height;
            frameWidth = width;
            frameHeight = height;
          }
          try {
            ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
          } finally {
            frame.close();
          }
        },
        error: (err) => {
          console.warn("rd: h264 decoder error", err);
        },
      });
      videoDecoder.configure({ codec: "avc1.42E01E", optimizeForLatency: true });
      return true;
    } catch (err) {
      console.warn("rd: h264 decoder unavailable", err);
      fallbackToJpegCodec(err);
      destroyVideoDecoder();
      return false;
    }
  }

  async function processFrameBuffer(buf) {
    const fps = buf[5];
    const format = buf[6];

    if (format === 1) {
      const jpegBytes = buf.slice(8);
      setCodecModeLabel("jpeg", "active");
      await drawJpegSlice(jpegBytes, null);
      updateFpsDisplay(fps);
      return;
    }

    if (format === 2 || format === 3) {
      setCodecModeLabel(format === 3 ? "raw" : "jpeg", format === 3 ? "blocks" : "blocks");
      if (buf.length < 16) return;
      const dv = new DataView(buf.buffer, 8);
      let pos = 0;
      const width = dv.getUint16(pos, true);
      pos += 2;
      const height = dv.getUint16(pos, true);
      pos += 2;
      if (width > 0 && height > 0) {
        frameWidth = width;
        frameHeight = height;
      }
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
          await drawJpegSlice(slice, { x, y, w, h });
        } else if (slice.length === w * h * 4) {
          const imgData = new ImageData(new Uint8ClampedArray(slice), w, h);
          ctx.putImageData(imgData, x, y);
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

      if (!h264FirstFrameAt) {
        h264FirstFrameAt = performance.now();
      }
      h264FramesSeen += 1;

      const isKey = isH264KeyFrame(h264Bytes);

      // If software H264 encode on the agent cannot keep up, automatically
      // fall back to JPEG blocks for a smoother interactive stream.
      const h264ElapsedMs = performance.now() - h264FirstFrameAt;
      if ((fps || 0) <= H264_LOW_FPS_THRESHOLD) {
        h264LowFpsStreak += 1;
      } else {
        h264LowFpsStreak = 0;
      }
      if (
        h264ElapsedMs >= H264_FALLBACK_WARMUP_MS &&
        h264FramesSeen >= H264_MIN_FRAMES_BEFORE_FALLBACK &&
        h264LowFpsStreak >= H264_LOW_FPS_STREAK_LIMIT
      ) {
        fallbackToJpegCodec(`low h264 fps (${fps})`);
        return;
      }

      const frameIntervalUs = Math.floor(1_000_000 / Math.max(1, fps || 25));
      const chunk = new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp: h264TimestampUs,
        data: h264Bytes,
      });
      h264TimestampUs += frameIntervalUs;
      try {
        videoDecoder.decode(chunk);
        h264KeyframeErrorStreak = 0;
        updateFpsDisplay(fps);
      } catch (err) {
        if (isKeyframeRequiredError(err)) {
          h264KeyframeErrorStreak += 1;
          const now = Date.now();
          if (now - h264LastDecodeWarnAt >= H264_DECODE_WARN_THROTTLE_MS) {
            h264LastDecodeWarnAt = now;
            console.warn("rd: h264 decode waiting for keyframe", {
              streak: h264KeyframeErrorStreak,
              recoveries: h264RecoveryAttempts,
            });
          }
          if (h264KeyframeErrorStreak >= H264_KEYFRAME_ERROR_RESTART_THRESHOLD) {
            const restarted = tryRecoverH264Stream("h264_keyframe_required");
            if (!restarted) {
              fallbackToJpegCodec("h264_keyframe_required_loop");
            }
          }
          return;
        }
        console.warn("rd: h264 decode failed", err);
        fallbackToJpegCodec(err);
      }
    }
  }

  function flushPendingFrame() {
    if (frameDecodeBusy || !pendingFrame) {
      return;
    }
    const next = pendingFrame;
    pendingFrame = null;
    frameDecodeBusy = true;
    processFrameBuffer(next).finally(() => {
      frameDecodeBusy = false;
      if (pendingFrame) {
        flushPendingFrame();
      }
    });
  }

  ws.addEventListener("message", function (ev) {
    if (ev.data instanceof ArrayBuffer) {
      const buf = new Uint8Array(ev.data);
      if (isFramePacket(buf)) {
        markFrameReceived();
        // Coalesce bursty arrivals so the renderer catches up to the newest frame.
        pendingFrame = buf;
        flushPendingFrame();
        return;
      }

      const msg = decodeMsgpack(buf);
      if (msg && msg.type === "status" && msg.status) {
        handleStatus(msg);
        return;
      }
      if (msg && msg.type === "input_latency") {
        updateLatency(Number(msg.ms) || 0);
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
    if (msg && msg.type === "input_latency") {
      updateLatency(Number(msg.ms) || 0);
      return;
    }
    if (msg && msg.type === "clipboard_content") {
      if (clipboardSyncCtrl && clipboardSyncCtrl.checked && streamState === "streaming" && msg.text) {
        lastClipboardText = msg.text;
        navigator.clipboard.writeText(msg.text).catch(() => {});
      }
      return;
    }
  });

  ws.addEventListener("open", function () {
    if (qualitySlider) {
      pushQuality(qualitySlider.value);
    }
    pushInputToggles();
    pushCaptureToggles();
    clearOfflineTimer();
    setStreamState("idle", "Stopped");
    fetchClientInfo().then(() => {
      if (displaySelect && displaySelect.value) {
        console.debug("rd: initial select display", displaySelect.value);
        sendCmd("desktop_select_display", {
          display: parseInt(displaySelect.value, 10),
        });
      }
    });
  });

  ws.addEventListener("close", function () {
    desiredStreaming = false;
    disconnectAudio();
    destroyVideoDecoder();
    setStreamState("disconnected", "Disconnected");
  });

  ws.addEventListener("error", function () {
    destroyVideoDecoder();
    setStreamState("error", "WebSocket error");
  });

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
        if (lastFrameAt && now - lastFrameAt < 2000) {
          if (streamState !== "stopping") {
            setStreamState("stopping", "Stopping stream");
          }
        } else if (streamState !== "idle") {
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
    const targetW = canvas.width || frameWidth;
    const targetH = canvas.height || frameHeight;
    if (!rect.width || !rect.height || !targetW || !targetH) return null;
    let x = ((e.clientX - rect.left) / rect.width) * targetW;
    let y = ((e.clientY - rect.top) / rect.height) * targetH;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    x = Math.max(0, Math.min(targetW - 1, Math.floor(x)));
    y = Math.max(0, Math.min(targetH - 1, Math.floor(y)));
    return { x, y };
  }

  function flushMouseMove() {
    moveTimer = null;
    if (!pendingMove || !mouseCtrl.checked) return;
    const now = performance.now();
    if (!smoothPoint) {
      smoothPoint = { x: pendingMove.x, y: pendingMove.y };
    }
    const factor = Math.max(0, Math.min(0.8, smoothingPct / 100));
    const alpha = 1 - factor;
    smoothPoint.x += (pendingMove.x - smoothPoint.x) * alpha;
    smoothPoint.y += (pendingMove.y - smoothPoint.y) * alpha;

    const sendPoint = {
      x: Math.round(smoothPoint.x),
      y: Math.round(smoothPoint.y),
    };

    if (now - lastMoveSentAt < mouseMoveIntervalMs) {
      if (!moveTimer) {
        moveTimer = setTimeout(flushMouseMove, mouseMoveIntervalMs);
      }
      return;
    }

    lastMoveSentAt = now;
    if (ws.bufferedAmount <= inputBackpressureBytes) {
      sendCmd("mouse_move", sendPoint);
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
      smoothPoint = { x: pt.x, y: pt.y };
      sendCmd("mouse_move", pt);
    }
    sendCmd("mouse_down", { button: e.button, ...(pt || {}) });
    e.preventDefault();
  });
  canvas.addEventListener("mouseup", function (e) {
    if (!mouseCtrl.checked) return;
    const pt = getCanvasPoint(e);
    if (pt) {
      pendingMove = pt;
      smoothPoint = { x: pt.x, y: pt.y };
      sendCmd("mouse_move", pt);
    }
    sendCmd("mouse_up", { button: e.button, ...(pt || {}) });
    e.preventDefault();
  });
  canvas.addEventListener("contextmenu", function (e) {
    e.preventDefault();
  });

  canvas.setAttribute("tabindex", "0");
  canvas.addEventListener("click", function () {
    canvas.focus({ preventScroll: true });
  });
  canvas.addEventListener("keydown", function (e) {
    if (!kbdCtrl.checked) return;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && typeof e.key === "string" && e.key.length === 1) {
      sendCmd("text_input", { text: e.key });
      e.preventDefault();
      return;
    }
    sendCmd("key_down", { key: e.key, code: e.code });
    e.preventDefault();
  });
  canvas.addEventListener("keyup", function (e) {
    if (!kbdCtrl.checked) return;
    if (!e.ctrlKey && !e.metaKey && !e.altKey && typeof e.key === "string" && e.key.length === 1) {
      e.preventDefault();
      return;
    }
    sendCmd("key_up", { key: e.key, code: e.code });
    e.preventDefault();
  });

  function stopOnExit() {
    if (ws.readyState === WebSocket.OPEN && desiredStreaming) {
      desiredStreaming = false;
      sendCmd("desktop_stop", {});
    }
    disconnectAudio();
    destroyVideoDecoder();
  }

  window.addEventListener("beforeunload", stopOnExit);
  window.addEventListener("pagehide", stopOnExit);

  fetchClientInfo();
})();
