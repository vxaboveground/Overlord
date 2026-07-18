import { encodeMsgpack, decodeMsgpack } from "./msgpack-helpers.js";
import { checkFeatureAccess } from "./feature-gate.js";
import { WhepClient } from "./whep.js";
import { P2PClient } from "./webrtc-p2p.js";
import { AdaptiveDesktopQuality, normalizeAdaptiveProfiles } from "./rd-adaptive-quality.js";
import { createKeyboardCapture } from "./keyboard-capture.js";
import { createSharedUiSettingsSaver, loadSharedUiSettings } from "./shared-ui-settings.js";

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

  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  const maxReconnectDelay = 15000;

  function buildWsUrl() {
    return (location.protocol === "https:" ? "wss://" : "ws://") +
      location.host +
      "/api/clients/" +
      clientId +
      "/rd/ws";
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
  const displaySelect = document.getElementById("displaySelect");
  const refreshBtn = document.getElementById("refreshDisplays");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const recordBtn = document.getElementById("recordBtn");
  const rdRecordingSettingsBtn = document.getElementById("rdRecordingSettingsBtn");
  const recordMode = document.getElementById("recordMode");
  const recordFps = document.getElementById("recordFps");
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const mouseCtrl = document.getElementById("mouseCtrl");
  const kbdCtrl = document.getElementById("kbdCtrl");
  const cursorCtrl = document.getElementById("cursorCtrl");
  const duplicationCtrl = document.getElementById("duplicationCtrl");
  const streamProfileSelect = document.getElementById("streamProfileSelect");
  const streamProfileDetail = document.getElementById("streamProfileDetail");
  const bitrateSelect = document.getElementById("bitrateSelect");
  const smoothingSlider = document.getElementById("smoothingSlider");
  const smoothingValue = document.getElementById("smoothingValue");
  const qualitySlider = document.getElementById("qualitySlider");
  const qualityValue = document.getElementById("qualityValue");
  const codecH264 = document.getElementById("codecH264");
  const softwareH264Ctrl = document.getElementById("softwareH264Ctrl");
  const codecMode = document.getElementById("codecMode");
  const canvas = document.getElementById("frameCanvas");
  const canvasContainer = document.getElementById("canvasContainer");
  const ctx = canvas.getContext("2d");
  const agentFps = document.getElementById("agentFps");
  const viewerFps = document.getElementById("viewerFps");
  const inputLatency = document.getElementById("inputLatency");
  const networkStats = document.getElementById("networkStats");
  const diagnosticsBtn = document.getElementById("diagnosticsBtn");
  const diagnosticsHud = document.getElementById("diagnosticsHud");
  const diagnosticsClose = document.getElementById("diagnosticsClose");
  const diagnosticEls = Object.fromEntries([
    "Summary", "Transport", "Codec", "Resolution", "Capture", "Encode", "Send", "AgentTotal",
    "Bitrate", "Rtt", "LossJitter", "JitterBuffer", "Decode", "Render", "Queue", "Dropped", "Fps", "Input",
  ].map((name) => [name, document.getElementById(`diag${name}`)]));
  const statusEl = document.getElementById("streamStatus");
  const clipboardSyncCtrl = document.getElementById("clipboardSyncCtrl");
  const privacyCtrl = document.getElementById("privacyCtrl");
  const audioCtrl = document.getElementById("audioCtrl");
  const webrtcMode = document.getElementById("webrtcMode");
  const webrtcVideo = document.getElementById("webrtcVideo");
  let whepClient = null;
  let p2pClient = null;
  let webrtcActive = false;
  function getWebrtcMode() {
    return webrtcMode ? String(webrtcMode.value || "off") : "off";
  }
  let activeClientId = clientId;
  let serverRecording = null;
  let recordingTimer = null;
  let pendingRecordingDownloadId = "";
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
  let videoDecoderConfigKey = "";
  const disabledDecoderCodecs = new Set();
  let h264StreamCodec = "";
  let canvasDecodePressure = false;
  let h264PendingTimings = [];
  let h264TimestampUs = 0;
  let prefersH264 = typeof VideoDecoder === "function";
  let negotiatedCodec = prefersH264 ? "h264" : "jpeg";
  let browserDecoderCodecs = ["jpeg", "raw"];
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
  const diagnostics = {
    agent: null,
    network: null,
    decodeMs: null,
    renderMs: null,
    decodeQueue: 0,
    coalescedFrames: 0,
    currentAgentFps: null,
    currentViewerFps: null,
    wsBitrateMbps: null,
    wsBytes: 0,
    wsWindowStartedAt: performance.now(),
    codec: "",
    width: 0,
    height: 0,
  };
  let encoderProfiles = [];
  let adaptiveProfileRunning = false;
  const adaptiveQuality = new AdaptiveDesktopQuality((target) => {
    sendCmd("desktop_set_profile", {
      maxHeight: target.maxHeight,
      fps: target.fps,
      source: "webrtc_auto",
      reason: target.reason,
    });
    sendCmd("desktop_set_bitrate", {
      bitrateMbps: target.bitrateMbps,
      adaptive: true,
      source: "webrtc_auto",
      reason: target.reason,
    });
    if (streamProfileDetail) {
      streamProfileDetail.textContent = `Auto: ${target.width}×${target.height} @ ${target.fps} FPS, ${target.bitrateMbps} Mbps. ${target.reason}.`;
    }
  });

  let clipboardSyncTimer = null;
  let lastClipboardText = "";
  let clipboardSyncActive = false;
  let elevationPending = false;
  let clientOs = "";
  let clientIsAdmin = false;
  let firewallWarningAcked = false;
  let firstFrameLogged = false;

  function rdDebug(label, data = {}) {
    try {
      console.debug(`rd: ${label} ${JSON.stringify(data)}`);
    } catch {
      console.debug(`rd: ${label}`, data);
    }
  }

  function resetH264RuntimeState() {
    h264TimestampUs = 0;
    h264StreamCodec = "";
    h264PendingTimings = [];
    diagnostics.decodeQueue = 0;
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

  const audioTransport = document.getElementById("audioTransport");
  const webrtcAudio = document.getElementById("webrtcAudio");
  let audioWhep = null;
  let audioP2P = null;
  function getAudioTransport() {
    return audioTransport ? String(audioTransport.value || "off") : "off";
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
      onState: (s) => console.debug("audio-webrtc[Relayed]: state", s),
    });
    try {
      await audioWhep.start();
    } catch (err) {
      console.warn("audio: WHEP start failed", err);
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
      onState: (s) => console.debug("audio-webrtc[P2P]: state", s),
    });
    audioP2P.start().catch((err) => {
      console.warn("audio: P2P start failed", err);
      audioP2P = null;
    });
  }

  function connectAudio() {
    if (audioWs && audioWs.readyState === WebSocket.OPEN) return;
    const mode = getAudioTransport();
    // The WS-PCM path requires an AudioContext — only init it when we
    // actually need it (WebRTC plays through the <audio> element instead).
    if (mode === "off") {
      initAudioPlayback();
      if (audioPlayCtx?.state === "suspended") audioPlayCtx.resume();
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // Each handler captures `ws` locally instead of reading the module-scope
    // `audioWs`. When the operator switches transports, the previous socket's
    // close event fires asynchronously and would otherwise null out the
    // freshly created replacement.
    const ws = new WebSocket(proto + "//" + location.host + "/api/clients/" + encodeURIComponent(clientId) + "/desktop-audio/ws");
    audioWs = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = function () {
      const start = { type: "start", source: "system" };
      if (mode === "relayed") start.webrtc = true;
      try { ws.send(JSON.stringify(start)); } catch (err) {
        console.warn("audio: send start failed", err);
        return;
      }
      if (mode === "p2p") startAudioP2P();
    };
    ws.onmessage = function (ev) {
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
      // Only feed PCM into the ScriptProcessor when the WS path is the active
      // playback — WebRTC modes ignore the parallel PCM uplink.
      if (mode === "off" && bytes.byteLength > 1) appendAudioPcm(bytes);
    };
    ws.onclose = function () {
      // Stale closes from a previous switch must not stomp the current
      // socket. Only do the global teardown if this WS is still active.
      if (audioWs === ws) {
        stopAudioWebrtc();
        cleanupAudio(false);
      }
    };
    ws.onerror = function () {};
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

  let savedDisplay = null;
  let savedStreamProfile = "auto";

  function setSelectValue(select, value) {
    if (!select || value === undefined || value === null) return false;
    const normalized = String(value);
    const exists = Array.from(select.options || []).some((opt) => opt.value === normalized);
    if (!exists) return false;
    select.value = normalized;
    return true;
  }

  function applySavedDisplay() {
    if (savedDisplay === null || savedDisplay === undefined) return;
    setSelectValue(displaySelect, savedDisplay);
  }

  function applySharedSettings(settings) {
    if (!settings || typeof settings !== "object") return;
    savedDisplay = Number.isFinite(Number(settings.display)) ? Number(settings.display) : savedDisplay;
    savedStreamProfile = settings.streamProfile ||
      ((settings.resolution !== undefined && settings.targetFps !== undefined)
        ? `${settings.resolution}:${settings.targetFps}`
        : savedStreamProfile);
    setSelectValue(streamProfileSelect, savedStreamProfile);
    setSelectValue(bitrateSelect, settings.bitrateMbps);
    setSelectValue(webrtcMode, settings.webrtcMode);
    setSelectValue(audioTransport, settings.audioTransport);
    setSelectValue(recordMode, settings.recordMode);
    setSelectValue(recordFps, settings.recordFps);
    if (qualitySlider && settings.quality !== undefined) qualitySlider.value = String(settings.quality);
    if (smoothingSlider && settings.smoothing !== undefined) {
      smoothingSlider.value = String(settings.smoothing);
      smoothingPct = Number(smoothingSlider.value) || 0;
    }
    if (mouseCtrl && typeof settings.mouse === "boolean") mouseCtrl.checked = settings.mouse;
    if (kbdCtrl && typeof settings.keyboard === "boolean") kbdCtrl.checked = settings.keyboard;
    if (cursorCtrl && typeof settings.cursor === "boolean") cursorCtrl.checked = settings.cursor;
    if (duplicationCtrl && typeof settings.duplication === "boolean") duplicationCtrl.checked = settings.duplication;
    if (softwareH264Ctrl && typeof settings.softwareH264 === "boolean") softwareH264Ctrl.checked = settings.softwareH264;
    if (clipboardSyncCtrl && typeof settings.clipboardSync === "boolean") clipboardSyncCtrl.checked = settings.clipboardSync;
    if (audioCtrl && typeof settings.audio === "boolean") audioCtrl.checked = settings.audio;
    if (typeof settings.preferH264 === "boolean") {
      prefersH264 = settings.preferH264 && typeof VideoDecoder === "function";
    }
    applySavedDisplay();
  }

  function readSharedSettings() {
    const profile = selectedStreamProfile();
    return {
      display: Number(displaySelect?.value || 0),
      streamProfile: streamProfileSelect?.value || "auto",
      // Keep the legacy fields so backstage and older remote-desktop builds that
      // share these preferences continue to receive equivalent settings.
      resolution: String(profile.maxHeight),
      targetFps: String(profile.fps),
      quality: Number(qualitySlider?.value || 90),
      bitrateMbps: Number(bitrateSelect?.value || 0),
      preferH264: !!prefersH264,
      webrtcMode: getWebrtcMode(),
      mouse: !!mouseCtrl?.checked,
      keyboard: !!kbdCtrl?.checked,
      cursor: !!cursorCtrl?.checked,
      duplication: !!duplicationCtrl?.checked,
      softwareH264: !!softwareH264Ctrl?.checked,
      clipboardSync: !!clipboardSyncCtrl?.checked,
      privacy: !!privacyCtrl?.checked,
      audio: !!audioCtrl?.checked,
      audioTransport: getAudioTransport(),
      smoothing: Number(smoothingSlider?.value || 20),
      recordMode: recordMode?.value || "normal",
      recordFps: recordFps?.value || "",
    };
  }

  applySharedSettings(await loadSharedUiSettings("remote_desktop"));
  const sharedSettingsSaver = createSharedUiSettingsSaver("remote_desktop", readSharedSettings);

  if (codecH264) {
    codecH264.checked = prefersH264;
    codecH264.disabled = typeof VideoDecoder !== "function";
  }
  if (softwareH264Ctrl) {
    softwareH264Ctrl.disabled = !prefersH264;
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
      diagnostics.currentAgentFps = Number(agentValue) || null;
    }
    const now = performance.now();
    renderCount += 1;
    const elapsed = now - renderWindowStart;
    if (elapsed >= 1000 && viewerFps) {
      const fps = Math.round((renderCount * 1000) / elapsed);
      viewerFps.textContent = String(fps);
      diagnostics.currentViewerFps = fps;
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
    const wsOpen = ws && ws.readyState === WebSocket.OPEN;
    const isStarting = streamState === "starting";
    const isStreaming = streamState === "streaming";
    const isStopping = streamState === "stopping";
    const isStalled = streamState === "stalled";
    const isBlocked = streamState === "offline" || streamState === "disconnected" || streamState === "error";
    const recordingActive = isRecording();

    if (startBtn) {
      startBtn.disabled = !wsOpen || isStarting || isStreaming || isStopping || isBlocked;
    }
    if (stopBtn) {
      stopBtn.disabled = !wsOpen || (!isStarting && !isStreaming && !isStopping && !isStalled);
    }
    if (recordBtn) {
      recordBtn.disabled =
        !recordingActive &&
        (!wsOpen || (!isStreaming && !isStalled) || getWebrtcMode() !== "off");
    }
    if (recordMode) {
      recordMode.disabled = recordingActive;
    }
    if (recordFps) {
      recordFps.disabled = recordingActive;
    }
    if (rdRecordingSettingsBtn) {
      rdRecordingSettingsBtn.disabled = recordingActive;
    }
  }

  function isRecording() {
    return !!serverRecording && ["starting", "recording", "stopping"].includes(serverRecording.status);
  }

  function formatRecordingDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function numericRecordingValue(value, fallback = 0) {
    if (typeof value === "bigint") return Number(value);
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  }

  function normalizeRecordingSummary(recording) {
    if (!recording) return null;
    const normalized = { ...recording };
    normalized.startedAt = numericRecordingValue(recording.startedAt, Date.now());
    if (recording.stoppedAt != null) normalized.stoppedAt = numericRecordingValue(recording.stoppedAt);
    for (const key of ["sourceFps", "targetFps", "segmentSeconds", "framesWritten", "framesDropped", "framesSkipped", "bytesWritten"]) {
      if (recording[key] != null) normalized[key] = numericRecordingValue(recording[key]);
    }
    if (Array.isArray(recording.files)) {
      normalized.files = recording.files.map((file) => ({
        ...file,
        size: numericRecordingValue(file?.size),
      }));
    }
    return normalized;
  }

  function selectedRecordingFps() {
    const fps = Number(recordFps?.value || 0);
    return Number.isFinite(fps) && fps > 0
      ? Math.max(1, Math.min(120, Math.floor(fps)))
      : 0;
  }

  function setRecordingUi(active) {
    if (!recordBtn) return;
    if (active) {
      recordBtn.classList.add("recording");
      recordBtn.title = "Stop recording";
      const startedAt = numericRecordingValue(serverRecording?.startedAt, Date.now());
      const elapsed = Date.now() - startedAt;
      const label = serverRecording?.status === "stopping"
        ? "Stopping"
        : formatRecordingDuration(elapsed);
      recordBtn.innerHTML = `<i class="fa-solid fa-stop"></i><span>${label}</span>`;
    } else {
      recordBtn.classList.remove("recording");
      recordBtn.title = "Record on the server using Canvas transport";
      recordBtn.innerHTML = '<i class="fa-solid fa-circle-dot"></i><span>Record</span>';
    }
  }

  function clearRecordingTimer() {
    if (recordingTimer) {
      clearInterval(recordingTimer);
      recordingTimer = null;
    }
  }

  function ensureRecordingTimer() {
    if (recordingTimer || !isRecording()) return;
    recordingTimer = setInterval(() => setRecordingUi(true), 1000);
  }

  function downloadRecordingFile(file) {
    if (!file?.downloadUrl) return false;
    console.debug("rd: recording download", {
      name: file.name || "",
      size: file.size || 0,
      url: file.downloadUrl,
    });
    const link = document.createElement("a");
    link.href = file.downloadUrl;
    link.download = file.name || "remote-desktop-recording.mp4";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  }

  function renderRecordingDownloads(recording) {
    if (!recording || !Array.isArray(recording.files) || recording.files.length === 0) return false;
    const mp4Files = recording.files.filter((file) => String(file?.name || "").toLowerCase().endsWith(".mp4"));
    const files = mp4Files.length ? mp4Files : recording.files;
    const latest = files[files.length - 1];
    if (!latest?.downloadUrl) return false;
    const message = recording.files.length === 1
      ? "Recording saved on the server."
      : `Recording saved on the server in ${recording.files.length} segments.`;
    console.info(message, recording.files);
    return downloadRecordingFile(latest);
  }

  function handleRecordingStatus(msg) {
    if (msg?.error) {
      alert(msg.error);
    }
    const previousId = serverRecording?.id || "";
    const previousActive = isRecording();
    serverRecording = normalizeRecordingSummary(msg?.recording);
    console.debug("rd: recording status", {
      status: serverRecording?.status || "none",
      id: serverRecording?.id || "",
      framesWritten: serverRecording?.framesWritten,
      framesSkipped: serverRecording?.framesSkipped,
      framesDropped: serverRecording?.framesDropped,
      files: Array.isArray(serverRecording?.files) ? serverRecording.files.length : 0,
      pendingDownloadId: pendingRecordingDownloadId,
    });
    const active = isRecording();
    if (active) {
      ensureRecordingTimer();
      setRecordingUi(true);
    } else {
      clearRecordingTimer();
      setRecordingUi(false);
    }
    updateControls();

    const completed =
      previousActive &&
      serverRecording &&
      serverRecording.id === previousId &&
      (serverRecording.status === "stopped" || serverRecording.status === "failed");
    const shouldDownload =
      serverRecording?.status === "stopped" &&
      pendingRecordingDownloadId &&
      (pendingRecordingDownloadId === "__pending__" || serverRecording.id === pendingRecordingDownloadId);
    if (completed || shouldDownload) {
      if (serverRecording.status === "failed") {
        alert(`Server recording failed: ${serverRecording.error || "Unknown error"}`);
        pendingRecordingDownloadId = "";
      } else if (shouldDownload) {
        if (renderRecordingDownloads(serverRecording)) {
          pendingRecordingDownloadId = "";
        } else if (serverRecording.status === "stopped") {
          alert("Server recording stopped, but no downloadable MP4 was produced.");
          pendingRecordingDownloadId = "";
        }
      }
    }
  }

  function startRecording() {
    if (isRecording()) return;
    if (getWebrtcMode() !== "off") {
      alert("Server-side recording uses the Canvas transport. Switch Transport to Canvas before recording.");
      return;
    }
    if (streamState !== "streaming" && streamState !== "stalled") {
      alert("Start the remote desktop stream before recording.");
      return;
    }
    serverRecording = {
      id: "",
      status: "starting",
      startedAt: Date.now(),
      files: [],
    };
    setRecordingUi(true);
    ensureRecordingTimer();
    updateControls();
    const requestedFps = selectedRecordingFps();
    const command = {
      compact: recordMode?.value === "compact",
    };
    if (requestedFps > 0) command.fps = requestedFps;
    console.debug("rd: recording start", {
      streamState,
      transport: getWebrtcMode(),
      requestedFps: requestedFps || "source",
      mode: recordMode?.value || "normal",
    });
    sendCmd("desktop_record_start", command);
  }

  function stopRecording() {
    if (!isRecording()) return;
    pendingRecordingDownloadId = serverRecording?.id || "__pending__";
    serverRecording = { ...serverRecording, status: "stopping" };
    setRecordingUi(true);
    updateControls();
    console.debug("rd: recording stop", {
      id: pendingRecordingDownloadId,
      framesWritten: serverRecording?.framesWritten,
      framesSkipped: serverRecording?.framesSkipped,
      framesDropped: serverRecording?.framesDropped,
    });
    sendCmd("desktop_record_stop", {});
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
    clipboardSyncCtrl.addEventListener("change", function () {
      checkClipboardSync();
      sharedSettingsSaver.scheduleSave();
    });
  }

  if (privacyCtrl) {
    privacyCtrl.addEventListener("change", function () {
      pushPrivacyToggle();
      sharedSettingsSaver.scheduleSave();
    });
  }

  function updateLatency(ms) {
    if (ms < 0 || !Number.isFinite(ms)) return;
    latencyAvg = latencyAvg == null ? ms : latencyAvg * 0.8 + ms * 0.2;
    if (inputLatency) {
      inputLatency.textContent = `${Math.round(latencyAvg)} ms`;
    }
  }

  function finite(value) {
    return Number.isFinite(value) ? Number(value) : null;
  }

  function smoothed(previous, next, weight = 0.25) {
    const value = finite(next);
    if (value == null) return previous;
    return previous == null ? value : previous * (1 - weight) + value * weight;
  }

  function msText(value) {
    const number = finite(value);
    return number == null ? "-- ms" : `${number < 10 ? number.toFixed(1) : Math.round(number)} ms`;
  }

  function setDiagnosticsVisible(visible) {
    if (!diagnosticsHud) return;
    diagnosticsHud.classList.toggle("hidden", !visible);
    diagnosticsBtn?.setAttribute("aria-pressed", visible ? "true" : "false");
    try { localStorage.setItem("overlord.rd.statsHud", visible ? "1" : "0"); } catch {}
  }

  function renderDiagnostics() {
    if (!diagnosticsHud) return;
    const agent = diagnostics.agent || {};
    const network = diagnostics.network || {};
    const media = network.video || network.audio || {};
    const mode = getWebrtcMode();
    const transport = mode === "p2p" ? "WebRTC P2P" : mode === "relayed" ? "WebRTC server" : "Canvas WebSocket";
    const bitrate = finite(media.bitrateMbps) ?? finite(diagnostics.wsBitrateMbps);
    const decodeMs = finite(media.decodeMs) ?? finite(diagnostics.decodeMs);
    const renderMs = finite(media.processingDelayMs) ?? finite(diagnostics.renderMs);
    const dropped = finite(media.framesDropped) ?? 0;
    const queue = mode === "off" ? diagnostics.decodeQueue : null;
    const fps = finite(agent.fps) ?? diagnostics.currentAgentFps;
    const viewerRate = finite(media.framesPerSecond) ?? diagnostics.currentViewerFps;
    const frameBudget = 1000 / Math.max(1, fps || viewerRate || 30);

    let summary = "Pipeline healthy";
    let severity = "ok";
    if (streamState !== "streaming" && streamState !== "stalled") {
      summary = "Stream is not active";
      severity = "warn";
    } else if (finite(agent.captureMs) > frameBudget * 0.75) {
      summary = "Capture is limiting frame rate";
      severity = "bad";
    } else if (finite(agent.encodeMs) > frameBudget * 0.75) {
      summary = "Encoder is limiting frame rate";
      severity = "bad";
    } else if (decodeMs != null && decodeMs > frameBudget * 0.75) {
      const viewerKeepingUp = fps != null && viewerRate != null && viewerRate >= fps * 0.9;
      summary = viewerKeepingUp
        ? `Decoder buffering adds ${Math.round(decodeMs)} ms`
        : "Viewer decoder throughput is limiting FPS";
      severity = viewerKeepingUp ? "warn" : "bad";
    } else if ((finite(media.lossPercent) ?? 0) > 3 || (finite(network.rttMs) ?? 0) > 150 || (finite(media.jitterMs) ?? 0) > 35) {
      summary = "Network conditions are causing delay";
      severity = "bad";
    } else if ((queue ?? 0) > 2 || (renderMs != null && renderMs > frameBudget)) {
      summary = "Viewer render queue is backing up";
      severity = "warn";
    } else if (!diagnostics.agent && !diagnostics.network) {
      summary = "Waiting for stream telemetry";
      severity = "warn";
    }

    diagnosticEls.Summary.textContent = summary;
    diagnosticEls.Summary.dataset.severity = severity;
    diagnosticEls.Transport.textContent = transport;
    diagnosticEls.Codec.textContent = String(media.codec || agent.format || diagnostics.codec || "--").toUpperCase();
    const width = finite(media.width) ?? diagnostics.width;
    const height = finite(media.height) ?? diagnostics.height;
    diagnosticEls.Resolution.textContent = width && height ? `${width}×${height}` : "--";
    diagnosticEls.Capture.textContent = msText(agent.captureMs);
    diagnosticEls.Encode.textContent = msText(agent.encodeMs);
    diagnosticEls.Send.textContent = msText(agent.sendMs);
    diagnosticEls.AgentTotal.textContent = msText(agent.totalMs);
    diagnosticEls.Bitrate.textContent = bitrate == null ? "-- Mbps" : `${bitrate.toFixed(2)} Mbps`;
    diagnosticEls.Rtt.textContent = msText(network.rttMs);
    diagnosticEls.LossJitter.textContent = `${finite(media.lossPercent)?.toFixed(1) ?? "--"}% / ${msText(media.jitterMs)}`;
    diagnosticEls.JitterBuffer.textContent = msText(media.jitterBufferMs);
    diagnosticEls.Decode.textContent = msText(decodeMs);
    diagnosticEls.Render.textContent = msText(renderMs);
    diagnosticEls.Queue.textContent = queue == null ? "managed by browser" : String(queue);
    diagnosticEls.Dropped.textContent = `${Math.round(dropped)} / ${diagnostics.coalescedFrames}`;
    diagnosticEls.Fps.textContent = `${fps == null ? "--" : Math.round(fps)} → ${viewerRate == null ? "--" : Math.round(viewerRate)}`;
    diagnosticEls.Input.textContent = msText(latencyAvg);
  }

  diagnosticsBtn?.addEventListener("click", () => setDiagnosticsVisible(diagnosticsHud?.classList.contains("hidden")));
  diagnosticsClose?.addEventListener("click", () => setDiagnosticsVisible(false));
  networkStats?.addEventListener("click", () => setDiagnosticsVisible(true));
  try { setDiagnosticsVisible(localStorage.getItem("overlord.rd.statsHud") === "1"); } catch {}
  setInterval(renderDiagnostics, 250);

  function updateNetworkStats(stats) {
    if (!networkStats || !stats) return;
    diagnostics.network = stats;
    const media = stats.video || stats.audio;
    const parts = [];
    if (Number.isFinite(media?.bitrateMbps)) parts.push(`${media.bitrateMbps.toFixed(1)} Mbps`);
    if (Number.isFinite(stats.rttMs)) parts.push(`${Math.round(stats.rttMs)} ms`);
    if (Number.isFinite(media?.lossPercent)) parts.push(`${media.lossPercent.toFixed(1)}% loss`);
    const route = [stats.protocol, stats.route].filter(Boolean).join("/");
    if (route) parts.push(route);
    networkStats.textContent = parts.join(" · ") || "Connected";
    const details = [];
    if (media?.codec) details.push(`Codec: ${media.codec}`);
    if (media?.width && media?.height) details.push(`Video: ${media.width}×${media.height}${media.framesPerSecond ? ` @ ${Math.round(media.framesPerSecond)} FPS` : ""}`);
    if (Number.isFinite(media?.jitterMs)) details.push(`Jitter: ${media.jitterMs.toFixed(1)} ms`);
    if (Number.isFinite(media?.jitterBufferMs)) details.push(`Jitter buffer: ${media.jitterBufferMs.toFixed(1)} ms`);
    if (Number.isFinite(media?.framesDropped)) details.push(`Frames dropped: ${media.framesDropped}`);
    if (Number.isFinite(stats.availableIncomingMbps)) details.push(`Available: ${stats.availableIncomingMbps.toFixed(1)} Mbps`);
    networkStats.title = details.join("\n");
    if (adaptiveProfileRunning) {
      adaptiveQuality.sample(stats, diagnostics.agent, Date.now());
    }
    renderDiagnostics();
  }

  function handleDesktopStreamStats(stats) {
    const previous = diagnostics.agent || {};
    diagnostics.agent = {
      ...stats,
      captureMs: smoothed(finite(previous.captureMs), stats.captureMs),
      encodeMs: smoothed(finite(previous.encodeMs), stats.encodeMs),
      sendMs: smoothed(finite(previous.sendMs), stats.sendMs),
      totalMs: smoothed(finite(previous.totalMs), stats.totalMs),
    };
    diagnostics.currentAgentFps = finite(stats.fps);
    diagnostics.codec = String(stats.format || diagnostics.codec || "");
    diagnostics.width = finite(stats.width) || diagnostics.width;
    diagnostics.height = finite(stats.height) || diagnostics.height;
    if (agentFps && diagnostics.currentAgentFps != null) {
      agentFps.textContent = String(Math.round(diagnostics.currentAgentFps));
    }
    renderDiagnostics();
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
    rdDebug("status", {
      status: msg.status,
      reason: msg.reason || "",
      desiredStreaming,
      streamState,
      lastFrameAgeMs: lastFrameAt ? Math.round(performance.now() - lastFrameAt) : null,
      sessionId: msg.sessionId || "",
    });
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
    if (msg.status === "starting") {
      clearOfflineTimer();
      if (desiredStreaming && streamState !== "streaming") {
        setStreamState("starting", "Starting stream");
      }
      return;
    }
    if (msg.status === "stopped") {
      clearOfflineTimer();
      desiredStreaming = false;
      lastFrameAt = 0;
      setStreamState("idle", "Stopped");
      return;
    }
    if (msg.status === "online") {
      clearOfflineTimer();
      if (elevationPending) {
        elevationPending = false;
        desiredStreaming = true;
      }
      if (desiredStreaming) {
        const shouldRequestStart = !["starting", "streaming", "stalled"].includes(streamState);
        const mode = getWebrtcMode();
        if (shouldRequestStart) {
          setStreamState("starting", "Reconnecting");
        }
        if (displaySelect && displaySelect.value !== undefined) {
          sendCmd("desktop_select_display", {
            display: parseInt(displaySelect.value, 10) || 0,
          });
        }
        pushInputToggles();
        pushCaptureToggles();
        if (qualitySlider) pushQuality(qualitySlider.value);
        pushStreamProfile();
        if (shouldRequestStart) {
          if (mode === "relayed") {
            sendCmd("desktop_start", { webrtc: true });
          } else if (mode === "p2p") {
            sendCmd("desktop_start", { canvasFlowControl: false });
            startP2P();
          } else {
            sendCmd("desktop_start", { canvasFlowControl: true });
          }
        }
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
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      rdDebug("send skipped websocket not open", {
        type,
        readyState: ws ? ws.readyState : -1,
        streamState,
        desiredStreaming,
      });
      return;
    }
    const msg = { type, ...payload };
    if (type !== "desktop_decode_pressure") {
      rdDebug("send", {
        msg,
        readyState: ws.readyState,
        streamState,
        desiredStreaming,
        display: displaySelect?.value ?? "",
        quality: qualitySlider?.value ?? "",
        streamProfile: streamProfileSelect?.value ?? "",
        transport: getWebrtcMode(),
        lastFrameAgeMs: lastFrameAt ? Math.round(performance.now() - lastFrameAt) : null,
      });
    }
    ws.send(encodeMsgpack(msg));
  }

  function setWebrtcViewActive(active) {
    webrtcActive = !!active;
    if (canvas) canvas.style.display = active ? "none" : "block";
    if (webrtcVideo) webrtcVideo.style.display = active ? "block" : "none";
    if (!active && networkStats) {
      networkStats.textContent = "--";
      networkStats.title = "";
      diagnostics.network = null;
    }
  }

  function onWebrtcState(label, s) {
    console.debug(`webrtc[${label}]: state`, s);
    if (s === "connected") {
      setStreamState("streaming", `Streaming (${label})`);
    } else if (s === "failed" || s === "disconnected") {
      setWebrtcViewActive(false);
    }
  }

  // The canvas path counts WS frames via markFrameReceived + updateFpsDisplay.
  // WebRTC bypasses WS entirely, so we tap the <video>'s rendered-frame callback
  // (Chrome/Edge/Firefox 132+) to feed the same counters — otherwise the
  // frame watcher flips to "No frames" and FPS sticks at --.
  let webrtcRvfcHandle = 0;
  let webrtcFpsCount = 0;
  let webrtcFpsWindowStart = 0;
  function startWebrtcFrameTicker() {
    if (!webrtcVideo || typeof webrtcVideo.requestVideoFrameCallback !== "function") return;
    stopWebrtcFrameTicker();
    webrtcFpsCount = 0;
    webrtcFpsWindowStart = performance.now();
    const tick = (now, metadata = {}) => {
      markFrameReceived();
      if (Number.isFinite(metadata.processingDuration)) {
        diagnostics.decodeMs = smoothed(diagnostics.decodeMs, metadata.processingDuration * 1000);
      }
      if (Number.isFinite(metadata.receiveTime) && Number.isFinite(metadata.expectedDisplayTime)) {
        diagnostics.renderMs = smoothed(diagnostics.renderMs, Math.max(0, metadata.expectedDisplayTime - metadata.receiveTime));
      }
      diagnostics.width = webrtcVideo.videoWidth || diagnostics.width;
      diagnostics.height = webrtcVideo.videoHeight || diagnostics.height;
      webrtcFpsCount += 1;
      const elapsed = now - webrtcFpsWindowStart;
      if (elapsed >= 1000) {
        const fps = Math.round((webrtcFpsCount * 1000) / elapsed);
        diagnostics.currentViewerFps = fps;
        updateFpsDisplay();
        webrtcFpsCount = 0;
        webrtcFpsWindowStart = now;
      } else {
        updateFpsDisplay();
      }
      webrtcRvfcHandle = webrtcVideo.requestVideoFrameCallback(tick);
    };
    webrtcRvfcHandle = webrtcVideo.requestVideoFrameCallback(tick);
  }
  function stopWebrtcFrameTicker() {
    if (webrtcRvfcHandle && webrtcVideo && typeof webrtcVideo.cancelVideoFrameCallback === "function") {
      webrtcVideo.cancelVideoFrameCallback(webrtcRvfcHandle);
    }
    webrtcRvfcHandle = 0;
  }

  async function startWhep(whepPath) {
    await stopAllWebrtc();
    if (!webrtcVideo) return;
    whepClient = new WhepClient({
      whepPath,
      videoEl: webrtcVideo,
      onState: (s) => onWebrtcState("WebRTC Relayed", s),
      onStats: (stats) => updateNetworkStats({ ...stats, route: "Server" }),
    });
    try {
      await whepClient.start();
      setWebrtcViewActive(true);
      startWebrtcFrameTicker();
    } catch (err) {
      console.warn("webrtc: WHEP start failed, falling back to canvas", err);
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
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeMsgpack(msg));
        }
      },
      onState: (s) => onWebrtcState("WebRTC P2P", s),
      onStats: updateNetworkStats,
    });
    try {
      await p2pClient.start();
      setWebrtcViewActive(true);
      startWebrtcFrameTicker();
    } catch (err) {
      console.warn("webrtc: P2P start failed, falling back to canvas", err);
      setWebrtcViewActive(false);
      const c = p2pClient;
      p2pClient = null;
      if (c) { try { await c.stop(); } catch {} }
    }
  }

  async function stopAllWebrtc() {
    stopWebrtcFrameTicker();
    setWebrtcViewActive(false);
    const w = whepClient;
    whepClient = null;
    if (w) { try { await w.stop(); } catch {} }
    const p = p2pClient;
    p2pClient = null;
    if (p) { try { await p.stop(); } catch {} }
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
    applySavedDisplay();
  }

  async function fetchClientInfo() {
    try {
      const res = await fetch("/api/clients");
      const data = await res.json();
      const client = data.items.find((c) => c.id === activeClientId);
      rdDebug("client info", {
        found: !!client,
        monitors: client?.monitors,
        monitorInfo: client?.monitorInfo,
        os: client?.os || "",
        isAdmin: !!client?.isAdmin,
      });
      if (client) {
        clientLabel.textContent = `${client.host || client.id} (${client.os || ""})`;
        clientOs = (client.os || "").toLowerCase();
        clientIsAdmin = !!client.isAdmin;
      }
      if (client) {
        populateDisplays(client.monitors, client.monitorInfo);
        applySavedDisplay();
        if (ws && ws.readyState === WebSocket.OPEN) requestEncoderCapabilities();
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
    const codec = q >= 100 ? "raw" : (negotiatedCodec || (prefersH264 ? "h264" : "jpeg"));
    const softwareH264 = codec === "h264" && useSoftwareH264();
    console.debug("rd: pushQuality val=", val, "q=", q, "codec=", codec, "softwareH264=", softwareH264);
    setCodecModeLabel(codec, "requested");
    if (codec === "h264" && !softwareH264) {
      ensureDuplicationForH264();
    }
    sendCmd("desktop_set_quality", { quality: q, codec, softwareH264 });
  }

  function useSoftwareH264() {
    return !!softwareH264Ctrl?.checked && prefersH264;
  }

  function ensureDuplicationForH264() {
    if (!duplicationCtrl || duplicationCtrl.disabled) return;
    const isWindows = clientOs.includes("windows") || clientOs.includes("win");
    if (!isWindows || duplicationCtrl.checked) return;
    duplicationCtrl.checked = true;
    sendCmd("desktop_set_duplication", { enabled: true });
  }

  if (codecH264) {
    codecH264.addEventListener("change", function () {
      resetH264SessionState();
      prefersH264 = !!codecH264.checked && typeof VideoDecoder === "function";
      negotiatedCodec = prefersH264 ? "h264" : "jpeg";
      if (softwareH264Ctrl) {
        softwareH264Ctrl.disabled = !prefersH264;
      }
      if (prefersH264 && !useSoftwareH264()) {
        ensureDuplicationForH264();
      }
      if (!prefersH264) {
        destroyVideoDecoder();
        h264LowFpsStreak = 0;
      }
      if (qualitySlider) {
        pushQuality(qualitySlider.value);
      }
      requestEncoderCapabilities();
      sharedSettingsSaver.scheduleSave();
    });
  }
  if (softwareH264Ctrl) {
    softwareH264Ctrl.addEventListener("change", function () {
      resetH264SessionState();
      if (qualitySlider) {
        pushQuality(qualitySlider.value);
      }
      sharedSettingsSaver.scheduleSave();
    });
  }

  function selectedStreamProfile() {
    if (streamProfileSelect?.value === "auto") {
      const best = encoderProfiles[0];
      return best ? { maxHeight: best.maxHeight, fps: best.fps } : { maxHeight: -1, fps: 120 };
    }
    const [heightValue, fpsValue] = String(streamProfileSelect?.value || "auto").split(":");
    const maxHeight = Number.parseInt(heightValue, 10);
    const fps = Number.parseInt(fpsValue, 10);
    return {
      maxHeight: Number.isFinite(maxHeight) ? maxHeight : 1080,
      fps: Number.isFinite(fps) ? Math.max(1, Math.min(240, fps)) : 60,
    };
  }

  function pushStreamProfile() {
    if (streamProfileSelect?.value === "auto") {
      const adaptiveWebrtc = getWebrtcMode() !== "off" && Number(bitrateSelect?.value || 0) === 0;
      if (adaptiveWebrtc && encoderProfiles.length) {
        adaptiveQuality.setProfiles(encoderProfiles);
        adaptiveProfileRunning = true;
        adaptiveQuality.start(Date.now());
        return;
      }
      adaptiveProfileRunning = false;
      adaptiveQuality.stop();
      const best = selectedStreamProfile();
      console.debug("rd: pushStreamProfile auto best", best);
      sendCmd("desktop_set_profile", { ...best, source: "auto_best" });
      if (streamProfileDetail) {
        const profile = encoderProfiles[0];
        streamProfileDetail.textContent = profile
          ? `Auto selected ${profile.width}×${profile.height} @ ${profile.fps} FPS (best available).`
          : "Auto selected native resolution while capabilities are loading.";
      }
      return;
    }
    adaptiveProfileRunning = false;
    adaptiveQuality.stop();
    const profile = selectedStreamProfile();
    console.debug("rd: pushStreamProfile", profile);
    sendCmd("desktop_set_profile", profile);
  }

  function pushBitrate() {
    const bitrateMbps = Math.max(0, Math.min(50, Number.parseInt(bitrateSelect?.value || "0", 10) || 0));
    if (adaptiveProfileRunning && bitrateMbps === 0) return;
    sendCmd("desktop_set_bitrate", { bitrateMbps, adaptive: false });
  }

  if (bitrateSelect) {
    bitrateSelect.addEventListener("change", function () {
      pushStreamProfile();
      pushBitrate();
      sharedSettingsSaver.scheduleSave();
    });
  }

  async function probeBrowserDecoderCodecs(transport) {
    const supported = ["jpeg", "raw"];
    if (transport === "webrtc") {
      try {
        const codecs = typeof RTCRtpReceiver !== "undefined" && typeof RTCRtpReceiver.getCapabilities === "function"
          ? (RTCRtpReceiver.getCapabilities("video")?.codecs || [])
          : [];
        for (const capability of codecs) {
          const mime = String(capability?.mimeType || "").toLowerCase();
          if (mime === "video/h264") supported.push("h264");
          if (mime === "video/h265" || mime === "video/hevc") supported.push("hevc");
        }
      } catch (err) {
        console.debug("rd: WebRTC codec capability probe failed", err);
      }
      return [...new Set(supported)];
    }

    if (typeof VideoDecoder !== "function") return supported;
    if (typeof VideoDecoder.isConfigSupported !== "function") {
      supported.push("h264");
      return supported;
    }
    const probes = [
      ["h264", "avc1.42E01E"],
      ["hevc", "hev1.1.6.L156.B0"],
    ];
    await Promise.all(probes.map(async ([name, codec]) => {
      try {
        const result = await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true });
        if (result?.supported) supported.push(name);
      } catch (err) {
        console.debug(`rd: ${name} decoder capability probe failed`, err);
      }
    }));
    return [...new Set(supported)].filter((codec) => !disabledDecoderCodecs.has(codec));
  }

  async function requestEncoderCapabilities() {
    if (streamProfileDetail) streamProfileDetail.textContent = "Checking hardware encoder profiles…";
    const mode = getWebrtcMode();
    const transport = mode === "off" ? "websocket" : "webrtc";
    const decoderCodecs = await probeBrowserDecoderCodecs(transport);
    browserDecoderCodecs = decoderCodecs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendCmd("desktop_encoder_capabilities", {
      display: Number.parseInt(displaySelect?.value || "0", 10) || 0,
      decoderCodecs,
      preferredCodecs: prefersH264 ? ["hevc", "h264", "jpeg", "raw"] : ["jpeg", "raw"],
      transport,
    });
  }

  function applyEncoderCapabilities(msg) {
    if (!msg) return;
    const selectedCodec = String(msg.selectedCodec || msg.negotiation?.selectedCodec || "").toLowerCase();
    if (selectedCodec) {
      negotiatedCodec = selectedCodec;
      const fallbacks = Array.isArray(msg.fallbackCodecs) ? msg.fallbackCodecs.join(" → ") : selectedCodec;
      setCodecModeLabel(selectedCodec, `negotiated; fallback ${fallbacks}`);
      if (codecH264) {
        const agentHasH264 = Array.isArray(msg.codecs) && msg.codecs.some((entry) => String(entry?.codec || "").toLowerCase() === "h264");
        codecH264.disabled = !browserDecoderCodecs.includes("h264") || !agentHasH264;
      }
      if (desiredStreaming && qualitySlider) pushQuality(qualitySlider.value);
    } else if (msg.transport === "webrtc") {
      console.warn("rd: no mutually supported WebRTC video codec; falling back to WebSocket canvas");
      if (webrtcMode) webrtcMode.value = "off";
      negotiatedCodec = browserDecoderCodecs.includes("h264") ? "h264" : "jpeg";
      setCodecModeLabel(negotiatedCodec, "WebRTC unavailable; WebSocket fallback");
      stopAllWebrtc();
      requestEncoderCapabilities();
    }
    if (!Array.isArray(msg.profiles) || !streamProfileSelect) return;
    const selectedDisplay = Number.parseInt(displaySelect?.value || "0", 10) || 0;
    if (Number.isFinite(Number(msg.display)) && Number(msg.display) !== selectedDisplay) return;
    const previous = streamProfileSelect.value;
    encoderProfiles = normalizeAdaptiveProfiles(msg.profiles);
    streamProfileSelect.innerHTML = "";
    const autoOption = document.createElement("option");
    autoOption.value = "auto";
    autoOption.textContent = "Auto (best)";
    autoOption.title = "Starts at the best supported profile and adapts to WebRTC congestion";
    streamProfileSelect.appendChild(autoOption);
    for (const profile of encoderProfiles) {
      const maxHeight = Number(profile.maxHeight);
      const fps = Number(profile.fps);
      if (!Number.isFinite(maxHeight) || !Number.isFinite(fps)) continue;
      const option = document.createElement("option");
      option.value = `${maxHeight}:${fps}`;
      option.textContent = String(profile.label || `${fps} FPS - ${Number(profile.height) || maxHeight}p`);
      const providers = Array.isArray(profile.providers) ? profile.providers.join(", ") : "";
      if (providers) {
        option.title = `Available through ${providers}`;
        option.dataset.providers = providers;
      }
      streamProfileSelect.appendChild(option);
    }
    if (streamProfileSelect.options.length === 1) {
      const option = document.createElement("option");
      option.value = "1080:60";
      option.textContent = "60 FPS - 1080p";
      streamProfileSelect.appendChild(option);
    }
    if (!setSelectValue(streamProfileSelect, savedStreamProfile || "auto") &&
        !setSelectValue(streamProfileSelect, previous) &&
        !setSelectValue(streamProfileSelect, "auto")) {
      streamProfileSelect.value = "auto";
    }
    savedStreamProfile = streamProfileSelect.value;
    if (streamProfileDetail) {
      const providers = streamProfileSelect.selectedOptions[0]?.dataset?.providers || "";
      const best = encoderProfiles[0];
      streamProfileDetail.textContent = streamProfileSelect.value === "auto" && best
        ? `Auto starts at ${best.width}×${best.height} @ ${best.fps} FPS and adapts on WebRTC.`
        : (providers ? `Available through ${providers}.` :
          (msg.detail || (msg.probed ? "Profiles tested on this display adapter." : "Safe fallback profiles shown.")));
    }
    if (desiredStreaming) pushStreamProfile();
  }

  if (streamProfileSelect) {
    streamProfileSelect.addEventListener("change", function () {
      savedStreamProfile = streamProfileSelect.value;
      const providers = streamProfileSelect.selectedOptions[0]?.dataset?.providers || "";
      if (streamProfileDetail && providers) streamProfileDetail.textContent = `Available through ${providers}.`;
      pushStreamProfile();
      pushBitrate();
      sharedSettingsSaver.scheduleSave();
    });
  }

  displaySelect.addEventListener("change", function () {
    console.debug("rd: select display", displaySelect.value);
    sendCmd("desktop_select_display", {
      display: parseInt(displaySelect.value, 10),
    });
    requestEncoderCapabilities();
    sharedSettingsSaver.scheduleSave();
  });

  if (webrtcMode) {
    webrtcMode.addEventListener("change", function () {
      updateControls();
      requestEncoderCapabilities();
      sharedSettingsSaver.scheduleSave();
    });
  }

  function needsWebrtcFirewallWarning(mode) {
    if (firewallWarningAcked) return false;
    if (mode !== "relayed" && mode !== "p2p") return false;
    const isWindows = clientOs.includes("windows") || clientOs.includes("win");
    return isWindows && !clientIsAdmin;
  }

  startBtn.addEventListener("click", function () {
    const mode = getWebrtcMode();
    rdDebug("start click", {
      mode,
      wsReadyState: ws.readyState,
      streamState,
      desiredStreaming,
      display: displaySelect?.value ?? "",
      quality: qualitySlider?.value ?? "",
      streamProfile: streamProfileSelect?.value ?? "",
      prefersH264,
      duplication: !!duplicationCtrl?.checked,
      clientOs,
      clientIsAdmin,
    });
    if (needsWebrtcFirewallWarning(mode)) {
      if (!confirm("This agent is not elevated. Starting WebRTC will trigger a Windows Defender Firewall prompt on the target machine.\n\nContinue?")) {
        return;
      }
      firewallWarningAcked = true;
    }
    if (displaySelect && displaySelect.value !== undefined) {
      sendCmd("desktop_select_display", {
        display: parseInt(displaySelect.value, 10) || 0,
      });
    }
    if (qualitySlider) {
      pushQuality(qualitySlider.value);
    }
    if (prefersH264 && !useSoftwareH264()) {
      ensureDuplicationForH264();
    }
    pushStreamProfile();
    pushBitrate();
    desiredStreaming = true;
    lastFrameAt = 0;
    firstFrameLogged = false;
    resetH264SessionState();
    setStreamState("starting", "Starting stream");
    if (mode === "relayed") {
      // Server replies with `webrtc_ready { whepPath }`; startWhep happens then.
      sendCmd("desktop_start", { webrtc: true });
    } else if (mode === "p2p") {
      // Kick off the P2P offer asynchronously; capture starts in parallel.
      sendCmd("desktop_start", { canvasFlowControl: false });
      startP2P();
    } else {
      sendCmd("desktop_start", { canvasFlowControl: true });
    }
    if (audioCtrl && audioCtrl.checked) {
      connectAudio();
    }
  });
  stopBtn.addEventListener("click", function () {
    if (isRecording()) stopRecording();
    desiredStreaming = false;
    adaptiveProfileRunning = false;
    adaptiveQuality.stop();
    lastFrameAt = 0;
    setStreamState("stopping", "Stopping stream");
    disablePrivacyIfActive();
    sendCmd("desktop_stop", {});
    disconnectAudio();
    stopAllWebrtc();
    setStreamState("idle", "Stopped");
  });
  if (recordBtn) {
    recordBtn.addEventListener("click", function () {
      if (isRecording()) stopRecording();
      else startRecording();
    });
  }
  if (recordMode) {
    recordMode.addEventListener("change", function () {
      sharedSettingsSaver.scheduleSave();
    });
  }
  if (recordFps) {
    recordFps.addEventListener("change", function () {
      sharedSettingsSaver.scheduleSave();
    });
  }
  fullscreenBtn.addEventListener("click", function () {
    if (canvasContainer.requestFullscreen) {
      canvasContainer.requestFullscreen();
    } else if (canvasContainer.webkitRequestFullscreen) {
      canvasContainer.webkitRequestFullscreen();
    } else if (canvasContainer.mozRequestFullScreen) {
      canvasContainer.mozRequestFullScreen();
    }
  });
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

  function pushPrivacyToggle() {
    if (!privacyCtrl) return;
    sendCmd(privacyCtrl.checked ? "privacy_start" : "privacy_stop", {});
  }

  function disablePrivacyIfActive() {
    if (privacyCtrl && privacyCtrl.checked) {
      privacyCtrl.checked = false;
      sendCmd("privacy_stop", {});
    }
  }

  mouseCtrl.addEventListener("change", function () {
    pushInputToggles();
    sharedSettingsSaver.scheduleSave();
  });
  const kbdCapture = createKeyboardCapture({
    container: canvas,
    sendKeyDown: (e) => sendCmd("key_down", { key: e.key, code: e.code }),
    sendKeyUp: (e) => sendCmd("key_up", { key: e.key, code: e.code }),
    onTextInput: (e) => sendCmd("text_input", { text: e.key }),
  });
  kbdCtrl.addEventListener("change", function () {
    if (kbdCtrl.checked) kbdCapture.enable();
    else kbdCapture.disable();
    pushInputToggles();
    sharedSettingsSaver.scheduleSave();
  });
  if (kbdCtrl.checked) kbdCapture.enable();
  document.addEventListener("fullscreenchange", function () {
    if (document.fullscreenElement === canvasContainer && kbdCtrl && !kbdCtrl.checked) {
      kbdCtrl.checked = true;
      kbdCtrl.dispatchEvent(new Event("change"));
    }
  });
  cursorCtrl.addEventListener("change", function () {
    pushCaptureToggles();
    sharedSettingsSaver.scheduleSave();
  });
  if (duplicationCtrl) {
    duplicationCtrl.addEventListener("change", function () {
      pushCaptureToggles();
      sharedSettingsSaver.scheduleSave();
    });
  }
  if (audioCtrl) {
    audioCtrl.addEventListener("change", function () {
      if (audioCtrl.checked) {
        connectAudio();
      } else {
        disconnectAudio();
      }
      sharedSettingsSaver.scheduleSave();
    });
  }
  if (audioTransport) {
    audioTransport.addEventListener("change", function () {
      // Reconnect with the new transport if audio is already on. Keep the
      // checkbox checked — the user is switching modes, not turning audio off.
      if (audioCtrl && audioCtrl.checked) {
        disconnectAudio(false);
        connectAudio();
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

  if (smoothingSlider) {
    updateSmoothingLabel(smoothingSlider.value);
    smoothingSlider.addEventListener("input", function () {
      smoothingPct = Number(smoothingSlider.value) || 0;
      updateSmoothingLabel(smoothingSlider.value);
      sharedSettingsSaver.scheduleSave();
    });
  }

  function isFramePacket(buf) {
    return buf.length >= 8 && buf[0] === 0x46 && buf[1] === 0x52 && buf[2] === 0x4d;
  }

  function markFrameReceived() {
    lastFrameAt = performance.now();
    clearOfflineTimer();
    if (!firstFrameLogged) {
      firstFrameLogged = true;
      rdDebug("first frame received", {
        streamState,
        desiredStreaming,
        canvas: { width: canvas.width, height: canvas.height },
        transport: getWebrtcMode(),
      });
    }
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
    updateCanvasDecodePressure(true);
    if (videoDecoder) {
      try {
        videoDecoder.close();
      } catch {
        // Ignore close errors when decoder is already shutting down.
      }
    }
    videoDecoder = null;
    videoDecoderConfigKey = "";
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
    negotiatedCodec = "jpeg";
    destroyVideoDecoder();
    if (codecH264) codecH264.checked = false;
    if (softwareH264Ctrl) softwareH264Ctrl.disabled = true;
    sharedSettingsSaver.scheduleSave();
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
        canvasFlowControl: getWebrtcMode() === "off",
      });
      const q = Number(qualitySlider?.value) || 90;
      sendCmd("desktop_set_quality", {
        quality: q,
        codec: "h264",
        softwareH264: useSoftwareH264(),
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

  function isHEVCKeyFrame(data) {
    for (let i = 0; i + 5 < data.length; i++) {
      let startCodeLen = 0;
      if (data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x01) {
        startCodeLen = 3;
      } else if (
        data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x00 && data[i + 3] === 0x01
      ) {
        startCodeLen = 4;
      }
      if (!startCodeLen) continue;
      const nalIndex = i + startCodeLen;
      if (nalIndex >= data.length) break;
      const nalType = (data[nalIndex] >> 1) & 0x3f;
      if (nalType >= 16 && nalType <= 21) return true;
      i = nalIndex;
    }
    return false;
  }

  function h264CodecFromAnnexB(data) {
    for (let i = 0; i + 7 < data.length; i++) {
      let startCodeLength = 0;
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) startCodeLength = 3;
      else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) startCodeLength = 4;
      if (!startCodeLength) continue;
      const nal = i + startCodeLength;
      if ((data[nal] & 0x1f) !== 7 || nal + 3 >= data.length) continue;
      return `avc1.${[data[nal + 1], data[nal + 2], data[nal + 3]]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")}`;
    }
    return "";
  }

  function ensureVideoDecoder(videoBytes, width, height, codecName) {
    const detectedCodec = codecName === "h264" ? h264CodecFromAnnexB(videoBytes) : "";
    const codec = codecName === "hevc"
      ? "hev1.1.6.L156.B0"
      : (detectedCodec || h264StreamCodec || "avc1.4d0034");
    const codedWidth = Math.max(0, Number(width) || 0);
    const codedHeight = Math.max(0, Number(height) || 0);
    const configKey = `${codec}:${codedWidth}x${codedHeight}`;
    if (videoDecoder && videoDecoderConfigKey === configKey) {
      return true;
    }
    if (typeof VideoDecoder !== "function") {
      return false;
    }
    try {
      if (videoDecoder) destroyVideoDecoder();
      videoDecoder = new VideoDecoder({
        output: (frame) => {
          const outputStartedAt = performance.now();
          const timing = h264PendingTimings.shift();
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
          const renderedAt = performance.now();
          if (timing) {
            diagnostics.decodeMs = smoothed(diagnostics.decodeMs, Math.max(0, outputStartedAt - timing.decodeStartedAt));
            diagnostics.renderMs = smoothed(diagnostics.renderMs, Math.max(0, renderedAt - timing.receivedAt));
          }
          diagnostics.decodeQueue = videoDecoder?.decodeQueueSize || h264PendingTimings.length;
          diagnostics.width = width;
          diagnostics.height = height;
          updateFpsDisplay();
          updateCanvasDecodePressure();
        },
        error: (err) => {
          console.warn(`rd: ${codecName} decoder error`, err);
          updateCanvasDecodePressure(true);
          setTimeout(() => fallbackFromVideoCodec(codecName, err), 0);
        },
      });
      videoDecoder.addEventListener("dequeue", () => {
        diagnostics.decodeQueue = videoDecoder?.decodeQueueSize || 0;
        updateCanvasDecodePressure();
      });
      const config = { codec, optimizeForLatency: true };
      if (codedWidth > 0 && codedHeight > 0) {
        config.codedWidth = codedWidth;
        config.codedHeight = codedHeight;
      }
      videoDecoder.configure(config);
      videoDecoderConfigKey = configKey;
      if (codecName === "h264") h264StreamCodec = codec;
      return true;
    } catch (err) {
      console.warn(`rd: ${codecName} decoder unavailable`, err);
      fallbackFromVideoCodec(codecName, err);
      destroyVideoDecoder();
      return false;
    }
  }

  function recordWsFrameBytes(byteLength) {
    diagnostics.wsBytes += Math.max(0, Number(byteLength) || 0);
    const now = performance.now();
    const elapsed = now - diagnostics.wsWindowStartedAt;
    if (elapsed >= 1000) {
      const rate = (diagnostics.wsBytes * 8) / (elapsed * 1000);
      diagnostics.wsBitrateMbps = smoothed(diagnostics.wsBitrateMbps, rate, 0.4);
      diagnostics.wsBytes = 0;
      diagnostics.wsWindowStartedAt = now;
    }
  }

  function fallbackFromVideoCodec(codec, reason) {
    if (codec === "hevc" && disabledDecoderCodecs.has("hevc")) return;
    const reasonText = normalizeFallbackReason(reason);
    if (codec === "hevc" && browserDecoderCodecs.includes("h264")) {
      disabledDecoderCodecs.add("hevc");
      browserDecoderCodecs = browserDecoderCodecs.filter((name) => name !== "hevc");
      negotiatedCodec = "h264";
      destroyVideoDecoder();
      console.warn("rd: falling back from hevc to h264", reasonText);
      setCodecModeLabel("h264", "HEVC fallback");
      if (ws.readyState === WebSocket.OPEN) {
        const q = Number(qualitySlider?.value) || 90;
        sendCmd("desktop_set_quality", {
          quality: q,
          codec: "h264",
          softwareH264: useSoftwareH264(),
          source: "viewer_fallback",
          reason: reasonText,
        });
        requestEncoderCapabilities();
      }
      return;
    }
    fallbackToJpegCodec(reasonText);
  }

  function recordCanvasFrameTiming(receivedAt, decodeStartedAt) {
    const renderedAt = performance.now();
    diagnostics.decodeMs = smoothed(diagnostics.decodeMs, Math.max(0, renderedAt - decodeStartedAt));
    diagnostics.renderMs = smoothed(diagnostics.renderMs, Math.max(0, renderedAt - receivedAt));
    diagnostics.decodeQueue = videoDecoder?.decodeQueueSize || (pendingFrame ? 1 : 0);
    diagnostics.width = frameWidth || canvas.width || diagnostics.width;
    diagnostics.height = frameHeight || canvas.height || diagnostics.height;
  }

  function updateCanvasDecodePressure(forceRelease = false) {
    const queueSize = videoDecoder?.decodeQueueSize || 0;
    const shouldApply = !forceRelease && getWebrtcMode() === "off" && queueSize > 3;
    const shouldRelease = forceRelease || getWebrtcMode() !== "off" || queueSize <= 1;
    let next = canvasDecodePressure;
    if (!canvasDecodePressure && shouldApply) next = true;
    else if (canvasDecodePressure && shouldRelease) next = false;
    if (next === canvasDecodePressure) return;
    canvasDecodePressure = next;
    sendCmd("desktop_decode_pressure", { active: next, queueSize });
  }

  async function processFrameBuffer(buf, receivedAt = performance.now()) {
    const decodeStartedAt = performance.now();
    const fps = buf[5];
    const format = buf[6];
    const headerLength = buf[3] >= 2 && buf.length >= 12 ? 12 : 8;
    const encodedWidth = headerLength === 12 ? buf[8] | (buf[9] << 8) : 0;
    const encodedHeight = headerLength === 12 ? buf[10] | (buf[11] << 8) : 0;
    if (encodedWidth > 0 && encodedHeight > 0) {
      frameWidth = encodedWidth;
      frameHeight = encodedHeight;
      diagnostics.width = encodedWidth;
      diagnostics.height = encodedHeight;
    }

    if (format === 1) {
      const jpegBytes = buf.slice(headerLength);
      setCodecModeLabel("jpeg", "active");
      diagnostics.codec = "jpeg";
      await drawJpegSlice(jpegBytes, null);
      recordCanvasFrameTiming(receivedAt, decodeStartedAt);
      updateFpsDisplay(fps);
      updateCanvasDecodePressure(true);
      return;
    }

    if (format === 2 || format === 3) {
      setCodecModeLabel(format === 3 ? "raw" : "jpeg", format === 3 ? "blocks" : "blocks");
      diagnostics.codec = format === 3 ? "raw blocks" : "jpeg blocks";
      if (buf.length < headerLength + 8) {
        updateCanvasDecodePressure(true);
        return;
      }
      const dv = new DataView(buf.buffer, buf.byteOffset + headerLength, buf.byteLength - headerLength);
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
        const start = headerLength + pos;
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
      recordCanvasFrameTiming(receivedAt, decodeStartedAt);
      updateCanvasDecodePressure(true);
      return;
    }

    if (format === 4 || format === 5) {
      const codecName = format === 5 ? "hevc" : "h264";
      setCodecModeLabel(codecName, "active");
      diagnostics.codec = codecName;
      const videoBytes = buf.slice(headerLength);
      if (!videoBytes.length) {
        updateCanvasDecodePressure(true);
        return;
      }
      if (!ensureVideoDecoder(videoBytes, encodedWidth || frameWidth, encodedHeight || frameHeight, codecName)) {
        updateCanvasDecodePressure(true);
        return;
      }

      if (!h264FirstFrameAt) {
        h264FirstFrameAt = performance.now();
      }
      h264FramesSeen += 1;

      const isKey = codecName === "hevc" ? isHEVCKeyFrame(videoBytes) : isH264KeyFrame(videoBytes);

      // If software H264 encode on the agent cannot keep up, automatically
      // fall back to JPEG blocks for a smoother interactive stream.
      const h264ElapsedMs = performance.now() - h264FirstFrameAt;
      if (codecName === "h264" && (fps || 0) <= H264_LOW_FPS_THRESHOLD) {
        h264LowFpsStreak += 1;
      } else {
        h264LowFpsStreak = 0;
      }
      if (
        codecName === "h264" &&
        h264ElapsedMs >= H264_FALLBACK_WARMUP_MS &&
        h264FramesSeen >= H264_MIN_FRAMES_BEFORE_FALLBACK &&
        h264LowFpsStreak >= H264_LOW_FPS_STREAK_LIMIT
      ) {
        fallbackToJpegCodec(`low h264 fps (${fps})`);
        updateCanvasDecodePressure(true);
        return;
      }

      const frameIntervalUs = Math.floor(1_000_000 / Math.max(1, fps || 25));
      const chunk = new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp: h264TimestampUs,
        data: videoBytes,
      });
      h264TimestampUs += frameIntervalUs;
      try {
        h264PendingTimings.push({ receivedAt, decodeStartedAt: performance.now() });
        videoDecoder.decode(chunk);
        diagnostics.decodeQueue = videoDecoder.decodeQueueSize;
        updateCanvasDecodePressure();
        h264KeyframeErrorStreak = 0;
      } catch (err) {
        h264PendingTimings.pop();
        if (codecName === "h264" && isKeyframeRequiredError(err)) {
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
          updateCanvasDecodePressure(true);
          return;
        }
        console.warn(`rd: ${codecName} decode failed`, err);
        fallbackFromVideoCodec(codecName, err);
        updateCanvasDecodePressure(true);
      }
      return;
    }
    updateCanvasDecodePressure(true);
  }

  function flushPendingFrame() {
    if (frameDecodeBusy || !pendingFrame) {
      return;
    }
    const next = pendingFrame;
    pendingFrame = null;
    frameDecodeBusy = true;
    processFrameBuffer(next.buf, next.receivedAt).finally(() => {
      frameDecodeBusy = false;
      if (pendingFrame) {
        flushPendingFrame();
      }
    });
  }

  function onWsMessage(ev) {
    if (ev.data instanceof ArrayBuffer) {
      const buf = new Uint8Array(ev.data);
      if (isFramePacket(buf)) {
        markFrameReceived();
        recordWsFrameBytes(buf.byteLength);
        // Coalesce bursty arrivals so the renderer catches up to the newest frame.
        if (pendingFrame) diagnostics.coalescedFrames += 1;
        pendingFrame = { buf, receivedAt: performance.now() };
        flushPendingFrame();
        return;
      }

      const msg = decodeMsgpack(buf);
      if (msg && msg.type === "desktop_encoder_capabilities") {
        applyEncoderCapabilities(msg);
        return;
      }
      if (msg && msg.type === "desktop_stream_stats") {
        handleDesktopStreamStats(msg);
        return;
      }
      if (msg && msg.type === "status" && msg.status) {
        handleStatus(msg);
        return;
      }
      if (msg && msg.type === "webrtc_ready" && typeof msg.whepPath === "string") {
        startWhep(msg.whepPath);
        return;
      }
      if (msg && msg.type === "webrtc_p2p_answer" && typeof msg.sdp === "string") {
        if (p2pClient) p2pClient.onAnswer(msg.sdp);
        return;
      }
      if (msg && msg.type === "webrtc_p2p_ice") {
        if (p2pClient) p2pClient.onRemoteCandidate(msg);
        return;
      }
      if (msg && msg.type === "input_latency") {
        updateLatency(Number(msg.ms) || 0);
        return;
      }
      if (msg && msg.type === "recording_status") {
        handleRecordingStatus(msg);
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
    if (msg && msg.type === "desktop_encoder_capabilities") {
      applyEncoderCapabilities(msg);
      return;
    }
    if (msg && msg.type === "desktop_stream_stats") {
      handleDesktopStreamStats(msg);
      return;
    }
    if (msg && msg.type === "status" && msg.status) {
      handleStatus(msg);
      return;
    }
    if (msg && msg.type === "input_latency") {
      updateLatency(Number(msg.ms) || 0);
      return;
    }
    if (msg && msg.type === "recording_status") {
      handleRecordingStatus(msg);
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
    rdDebug("ws open", {
      url: ws.url,
      readyState: ws.readyState,
      clientId,
    });
    if (qualitySlider) {
      pushQuality(qualitySlider.value);
    }
    pushBitrate();
    pushInputToggles();
    pushCaptureToggles();
    clearOfflineTimer();
    if (desiredStreaming) {
      setStreamState("starting", "Resuming stream");
      if (displaySelect && displaySelect.value !== undefined) {
        sendCmd("desktop_select_display", {
          display: parseInt(displaySelect.value, 10) || 0,
        });
      }
      pushStreamProfile();
      const mode = getWebrtcMode();
      if (mode === "relayed") {
        sendCmd("desktop_start", { webrtc: true });
      } else if (mode === "p2p") {
        sendCmd("desktop_start", { canvasFlowControl: false });
        startP2P();
      } else {
        sendCmd("desktop_start", { canvasFlowControl: true });
      }
    } else {
      setStreamState("idle", "Stopped");
    }
    sendCmd("desktop_record_status", {});
    requestEncoderCapabilities();
    fetchClientInfo().then(() => {
      if (displaySelect && displaySelect.value) {
        console.debug("rd: initial select display", displaySelect.value);
        sendCmd("desktop_select_display", {
          display: parseInt(displaySelect.value, 10),
        });
      }
    });
  }

  function onWsClose(event) {
    rdDebug("ws close", {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      streamState,
      desiredStreaming,
    });
    disconnectAudio();
    destroyVideoDecoder();
    stopAllWebrtc();
    if (desiredStreaming) {
      setStreamState("connecting", "Reconnecting");
      scheduleReconnect();
    } else {
      clearRecordingTimer();
      serverRecording = null;
      setRecordingUi(false);
      setStreamState("disconnected", "Disconnected");
    }
  }

  function onWsError(event) {
    console.warn("rd: ws error", event);
    destroyVideoDecoder();
    stopAllWebrtc();
    setStreamState("error", "WebSocket error");
  }

  connectWs();

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
    if (ws && ws.bufferedAmount <= inputBackpressureBytes) {
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
  canvas.addEventListener("wheel", function (e) {
    if (!mouseCtrl.checked) return;
    const pt = getCanvasPoint(e);
    if (!pt) return;
    const delta = Math.max(-120, Math.min(120, Math.round(-e.deltaY)));
    sendCmd("mouse_wheel", { delta, x: pt.x, y: pt.y });
    e.preventDefault();
  }, { passive: false });

  canvas.setAttribute("tabindex", "0");
  canvas.addEventListener("click", function () {
    canvas.focus({ preventScroll: true });
  });

  function stopOnExit() {
    sharedSettingsSaver.saveNow();
    if (isRecording()) stopRecording();
    disablePrivacyIfActive();
    if (ws && ws.readyState === WebSocket.OPEN && desiredStreaming) {
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
