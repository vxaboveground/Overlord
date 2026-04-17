import { fetchVoiceCapabilities } from "./data.js";
import { checkFeatureAccess } from "./feature-gate.js";

const params = new URLSearchParams(window.location.search);
const clientId = params.get("clientId") || "";

if (!clientId) {
  alert("Missing clientId");
  throw new Error("Missing clientId");
}

const connectBtn = document.getElementById("connect-btn");
const disconnectBtn = document.getElementById("disconnect-btn");
const statusPill = document.getElementById("status-pill");
const localWaveCanvas = document.getElementById("local-wave");
const remoteWaveCanvas = document.getElementById("remote-wave");
const sourceSelect = document.getElementById("source-select");
const muteSelfBtn = document.getElementById("mute-self-btn");
const muteRemoteBtn = document.getElementById("mute-remote-btn");
const micVolumeSlider = document.getElementById("mic-volume");
const micVolumeLabel = document.getElementById("mic-volume-label");
const remoteVolumeSlider = document.getElementById("remote-volume");
const remoteVolumeLabel = document.getElementById("remote-volume-label");

let micGain = 1.0;
let remoteGain = 1.0;

let ws = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let captureAudioCtx = null;
let playAudioCtx = null;
let playProcessorNode = null;
let playGainNode = null;
let selfMuted = true;
let remoteMuted = true;
let playbackChunks = [];
let playbackChunkReadOffset = 0;
let levelLoopRunning = false;
const WAVE_SIZE = 2048;
const WAVE_VISUAL_GAIN = 1.8;
const CAPTURE_FRAME_SIZE = 512;
const PLAYBACK_FRAME_SIZE = 512;
const MAX_PLAYBACK_BUFFER_MS = 120;
const localWaveBuffer = new Float32Array(WAVE_SIZE);
const remoteWaveBuffer = new Float32Array(WAVE_SIZE);
let localWaveWrite = 0;
let remoteWaveWrite = 0;

const UPLINK_SAMPLE_RATE = 16000;

function sourceLabel(source) {
  if (source === "default" || source === "microphone") {
    return "Default Input";
  }
  if (source === "system") {
    return "System Audio";
  }
  if (typeof source === "string" && source.startsWith("device:")) {
    const name = source.slice("device:".length).trim();
    return name || "Audio Device";
  }
  return String(source || "Audio Source");
}

function setStatus(text, cls) {
  if (!statusPill) return;
  statusPill.className =
    "inline-flex items-center gap-2 px-3 py-1.5 rounded-full border " + cls;
  statusPill.innerHTML = `<i class="fa-solid fa-circle"></i><span>${text}</span>`;
}

function downsampleTo16k(float32Buffer, sampleRate) {
  if (sampleRate === 16000) return float32Buffer;
  const ratio = sampleRate / 16000;
  const newLength = Math.round(float32Buffer.length / ratio);
  const out = new Float32Array(newLength);
  let offsetOut = 0;
  let offsetIn = 0;
  while (offsetOut < out.length) {
    const nextOffsetIn = Math.round((offsetOut + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetIn; i < nextOffsetIn && i < float32Buffer.length; i++) {
      accum += float32Buffer[i];
      count++;
    }
    out[offsetOut] = count > 0 ? accum / count : 0;
    offsetOut++;
    offsetIn = nextOffsetIn;
  }
  return out;
}

function floatToInt16(float32Buffer) {
  const out = new Int16Array(float32Buffer.length);
  for (let i = 0; i < float32Buffer.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Buffer[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function clearPlaybackQueue() {
  playbackChunks = [];
  playbackChunkReadOffset = 0;
}

function pushWaveSamples(ring, writePos, samples) {
  for (let i = 0; i < samples.length; i++) {
    ring[writePos] = samples[i];
    writePos = (writePos + 1) % ring.length;
  }
  return writePos;
}

function ensureCanvasSize(canvas) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function drawWave(canvas, ring, writePos, strokeStyle) {
  if (!canvas) return;
  ensureCanvasSize(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;

  ctx.fillStyle = "rgba(15, 23, 42, 0.72)";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
  ctx.lineWidth = Math.max(1, Math.floor((window.devicePixelRatio || 1)));
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();

  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = Math.max(1.5, 1.5 * (window.devicePixelRatio || 1));
  ctx.beginPath();
  const len = ring.length;
  for (let x = 0; x < w; x++) {
    const idx = (writePos + Math.floor((x / w) * len)) % len;
    const sample = Math.max(-1, Math.min(1, (ring[idx] || 0) * WAVE_VISUAL_GAIN));
    const y = mid - sample * (h * 0.42);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function startLevelLoop() {
  if (levelLoopRunning) return;
  levelLoopRunning = true;

  const tick = () => {
    if (!levelLoopRunning) return;

    drawWave(localWaveCanvas, localWaveBuffer, localWaveWrite, "rgba(34, 211, 238, 0.95)");
    drawWave(remoteWaveCanvas, remoteWaveBuffer, remoteWaveWrite, "rgba(16, 185, 129, 0.95)");

    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}

function stopLevelLoop() {
  levelLoopRunning = false;
  localWaveBuffer.fill(0);
  remoteWaveBuffer.fill(0);
  localWaveWrite = 0;
  remoteWaveWrite = 0;
  drawWave(localWaveCanvas, localWaveBuffer, localWaveWrite, "rgba(34, 211, 238, 0.95)");
  drawWave(remoteWaveCanvas, remoteWaveBuffer, remoteWaveWrite, "rgba(16, 185, 129, 0.95)");
}

function resampleInt16ToFloat32(srcInt16, srcRate, dstRate) {
  if (!srcInt16 || srcInt16.length === 0) {
    return new Float32Array(0);
  }

  if (srcRate === dstRate) {
    const out = new Float32Array(srcInt16.length);
    for (let i = 0; i < srcInt16.length; i++) {
      out[i] = srcInt16[i] / 0x8000;
    }
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
    const sample = srcInt16[i0] * (1 - frac) + srcInt16[i1] * frac;
    out[i] = sample / 0x8000;
  }

  return out;
}

function appendPlaybackPcm(binary) {
  if (!playAudioCtx) {
    initPlaybackEngine();
  }

  const samples = Math.floor(binary.byteLength / 2);
  if (samples <= 0) return;
  const src = new Int16Array(binary.buffer, binary.byteOffset, samples);
  const chunk = resampleInt16ToFloat32(src, UPLINK_SAMPLE_RATE, playAudioCtx?.sampleRate || UPLINK_SAMPLE_RATE);
  if (chunk.length === 0) return;
  playbackChunks.push(chunk);
  remoteWaveWrite = pushWaveSamples(remoteWaveBuffer, remoteWaveWrite, chunk);

  // Keep roughly <= 2 seconds buffered to avoid stale replay artifacts.
  let bufferedSamples = -playbackChunkReadOffset;
  for (const chunk of playbackChunks) bufferedSamples += chunk.length;
  const sampleRate = playAudioCtx?.sampleRate || UPLINK_SAMPLE_RATE;
  const maxSamples = Math.max(PLAYBACK_FRAME_SIZE, Math.round(sampleRate * (MAX_PLAYBACK_BUFFER_MS / 1000)));
  while (bufferedSamples > maxSamples && playbackChunks.length > 0) {
    const dropped = playbackChunks.shift();
    bufferedSamples -= dropped?.length || 0;
    playbackChunkReadOffset = 0;
  }
}

function initPlaybackEngine() {
  if (!playAudioCtx) {
    playAudioCtx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
  }
  if (!playGainNode) {
    playGainNode = playAudioCtx.createGain();
    playGainNode.gain.value = remoteGain;
    playGainNode.connect(playAudioCtx.destination);
  }
  if (!playProcessorNode) {
    playProcessorNode = playAudioCtx.createScriptProcessor(PLAYBACK_FRAME_SIZE, 1, 1);
    playProcessorNode.onaudioprocess = (event) => {
      const out = event.outputBuffer.getChannelData(0);
      out.fill(0);

      if (remoteMuted) return;

      let writeIndex = 0;
      while (writeIndex < out.length && playbackChunks.length > 0) {
        const head = playbackChunks[0];
        const remaining = head.length - playbackChunkReadOffset;
        if (remaining <= 0) {
          playbackChunks.shift();
          playbackChunkReadOffset = 0;
          continue;
        }

        const needed = out.length - writeIndex;
        const take = Math.min(needed, remaining);
        out.set(head.subarray(playbackChunkReadOffset, playbackChunkReadOffset + take), writeIndex);

        writeIndex += take;
        playbackChunkReadOffset += take;
        if (playbackChunkReadOffset >= head.length) {
          playbackChunks.shift();
          playbackChunkReadOffset = 0;
        }
      }
    };
    playProcessorNode.connect(playGainNode);
  }
}

async function startMicCapture() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });
  captureAudioCtx = new AudioContext({ latencyHint: "interactive" });
  sourceNode = captureAudioCtx.createMediaStreamSource(mediaStream);
  processorNode = captureAudioCtx.createScriptProcessor(CAPTURE_FRAME_SIZE, 1, 1);

  sourceNode.connect(processorNode);
  processorNode.connect(captureAudioCtx.destination);

  processorNode.onaudioprocess = (event) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (selfMuted) return;

    const inData = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleTo16k(inData, captureAudioCtx.sampleRate);
    if (micGain !== 1.0) {
      for (let i = 0; i < downsampled.length; i++) downsampled[i] *= micGain;
    }
    localWaveWrite = pushWaveSamples(localWaveBuffer, localWaveWrite, downsampled);
    const pcm16 = floatToInt16(downsampled);

    ws.send(pcm16.buffer);
  };
}

function stopMicCapture() {
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (captureAudioCtx) {
    captureAudioCtx.close().catch(() => {});
    captureAudioCtx = null;
  }
  if (playProcessorNode) {
    playProcessorNode.disconnect();
    playProcessorNode.onaudioprocess = null;
    playProcessorNode = null;
  }
  if (playGainNode) {
    playGainNode.disconnect();
    playGainNode = null;
  }
  if (playAudioCtx) {
    playAudioCtx.close().catch(() => {});
    playAudioCtx = null;
  }
  stopLevelLoop();
  clearPlaybackQueue();
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

function updateMuteButtons() {
  if (muteSelfBtn) {
    muteSelfBtn.innerHTML = selfMuted
      ? '<i class="fa-solid fa-microphone-slash"></i> Unmute Me'
      : '<i class="fa-solid fa-microphone"></i> Mute Me';
  }
  if (muteRemoteBtn) {
    muteRemoteBtn.innerHTML = remoteMuted
      ? '<i class="fa-solid fa-volume-xmark"></i> Unmute Them'
      : '<i class="fa-solid fa-volume-high"></i> Mute Them';
  }
}

async function connectVoice() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  // Start each new session with both directions muted by default.
  selfMuted = true;
  remoteMuted = true;
  clearPlaybackQueue();
  startLevelLoop();
  updateMuteButtons();

  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${window.location.host}/api/clients/${encodeURIComponent(clientId)}/voice/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = async () => {
    setStatus("Connecting", "border-blue-700 bg-blue-900/40 text-blue-100");
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    try {
      await startMicCapture();
      initPlaybackEngine();
      const chosenSource = sourceSelect?.value || "default";
      ws.send(JSON.stringify({ type: "start", source: chosenSource }));
    } catch {
      alert("Microphone access denied or unavailable.");
      disconnectVoice();
    }
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === "status") {
          if (msg.status === "offline") {
            setStatus("Client Offline", "border-amber-700 bg-amber-900/30 text-amber-200");
          } else if (msg.status === "connected") {
            setStatus("Connected", "border-emerald-700 bg-emerald-900/40 text-emerald-100");
          } else if (msg.status === "error") {
            setStatus("Voice Error", "border-red-700 bg-red-900/40 text-red-100");
          }
        }
      } catch {}
      return;
    }

    const bytes = new Uint8Array(ev.data);
    if (bytes.byteLength > 1) {
      appendPlaybackPcm(bytes);
    }
  };

  ws.onclose = () => {
    stopMicCapture();
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    setStatus("Disconnected", "border-slate-700 bg-slate-800 text-slate-300");
  };

  ws.onerror = () => {
    setStatus("Error", "border-red-700 bg-red-900/40 text-red-100");
  };
}

function disconnectVoice() {
  stopMicCapture();
  if (ws) {
    try {
      ws.send(JSON.stringify({ type: "stop" }));
    } catch {}
    try {
      ws.close();
    } catch {}
    ws = null;
  }
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  setStatus("Disconnected", "border-slate-700 bg-slate-800 text-slate-300");
}

async function loadCapabilities() {
  setStatus("Checking", "border-blue-700 bg-blue-900/40 text-blue-100");
  const result = await fetchVoiceCapabilities(clientId);
  const caps = result.capabilities;
  if (!result.ok || !caps?.available) {
    setStatus("Voice Unavailable", "border-amber-700 bg-amber-900/30 text-amber-200");
    connectBtn.disabled = true;
    const message = result.error || caps?.detail || "Voice support is unavailable on this client.";
    alert(message);
    return;
  }

  const sources = Array.isArray(caps.sources) && caps.sources.length > 0 ? caps.sources : ["default"];
  if (!sources.includes("system")) sources.push("system");
  const defaultSource = caps.defaultSource && sources.includes(caps.defaultSource) ? caps.defaultSource : sources[0];

  if (sourceSelect) {
    sourceSelect.innerHTML = "";
    for (const source of sources) {
      const option = document.createElement("option");
      option.value = source;
      option.textContent = sourceLabel(source);
      sourceSelect.appendChild(option);
    }
    sourceSelect.value = defaultSource;
  }

  setStatus("Ready", "border-slate-700 bg-slate-800 text-slate-300");
}

connectBtn?.addEventListener("click", connectVoice);
disconnectBtn?.addEventListener("click", disconnectVoice);
muteSelfBtn?.addEventListener("click", () => {
  selfMuted = !selfMuted;
  updateMuteButtons();
});
muteRemoteBtn?.addEventListener("click", () => {
  remoteMuted = !remoteMuted;
  if (remoteMuted) {
    clearPlaybackQueue();
  }
  updateMuteButtons();
});
window.addEventListener("beforeunload", disconnectVoice);

micVolumeSlider?.addEventListener("input", () => {
  micGain = parseInt(micVolumeSlider.value, 10) / 100;
  if (micVolumeLabel) micVolumeLabel.textContent = micVolumeSlider.value + "%";
});
remoteVolumeSlider?.addEventListener("input", () => {
  remoteGain = parseInt(remoteVolumeSlider.value, 10) / 100;
  if (playGainNode) playGainNode.gain.value = remoteGain;
  if (remoteVolumeLabel) remoteVolumeLabel.textContent = remoteVolumeSlider.value + "%";
});

updateMuteButtons();
drawWave(localWaveCanvas, localWaveBuffer, localWaveWrite, "rgba(34, 211, 238, 0.95)");
drawWave(remoteWaveCanvas, remoteWaveBuffer, remoteWaveWrite, "rgba(16, 185, 129, 0.95)");
checkFeatureAccess("voice", clientId).then(ok => {
  if (ok) {
    loadCapabilities();
  } else {
    connectBtn.disabled = true;
  }
});

/* =====================================================================
   Desktop Audio – independent listen-only stream (system/loopback)
   ===================================================================== */

const daConnectBtn   = document.getElementById("da-connect-btn");
const daDisconnectBtn = document.getElementById("da-disconnect-btn");
const daStatusPill   = document.getElementById("da-status-pill");
const daWaveCanvas   = document.getElementById("da-wave");
const daVolumeSlider = document.getElementById("da-volume");
const daVolumeLabel  = document.getElementById("da-volume-label");

let daWs = null;
let daGain = 1.0;
let daPlayAudioCtx = null;
let daPlayProcessorNode = null;
let daPlayGainNode = null;
let daPlaybackChunks = [];
let daPlaybackChunkReadOffset = 0;
let daLevelLoop = false;
const DA_WAVE_SIZE = 2048;
const daWaveBuffer = new Float32Array(DA_WAVE_SIZE);
let daWaveWrite = 0;

function daSetStatus(text, cls) {
  if (!daStatusPill) return;
  daStatusPill.className =
    "inline-flex items-center gap-2 px-3 py-1.5 rounded-full border " + cls;
  daStatusPill.innerHTML = `<i class="fa-solid fa-circle"></i><span>${text}</span>`;
}

function daClearPlayback() {
  daPlaybackChunks = [];
  daPlaybackChunkReadOffset = 0;
}

function daStartLevelLoop() {
  if (daLevelLoop) return;
  daLevelLoop = true;
  const tick = () => {
    if (!daLevelLoop) return;
    drawWave(daWaveCanvas, daWaveBuffer, daWaveWrite, "rgba(251, 191, 36, 0.95)");
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function daStopLevelLoop() {
  daLevelLoop = false;
  daWaveBuffer.fill(0);
  daWaveWrite = 0;
  drawWave(daWaveCanvas, daWaveBuffer, daWaveWrite, "rgba(251, 191, 36, 0.95)");
}

function daInitPlaybackEngine() {
  if (!daPlayAudioCtx) {
    daPlayAudioCtx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
  }
  if (!daPlayGainNode) {
    daPlayGainNode = daPlayAudioCtx.createGain();
    daPlayGainNode.gain.value = daGain;
    daPlayGainNode.connect(daPlayAudioCtx.destination);
  }
  if (!daPlayProcessorNode) {
    daPlayProcessorNode = daPlayAudioCtx.createScriptProcessor(PLAYBACK_FRAME_SIZE, 1, 1);
    daPlayProcessorNode.onaudioprocess = (event) => {
      const out = event.outputBuffer.getChannelData(0);
      out.fill(0);
      let writeIndex = 0;
      while (writeIndex < out.length && daPlaybackChunks.length > 0) {
        const head = daPlaybackChunks[0];
        const remaining = head.length - daPlaybackChunkReadOffset;
        if (remaining <= 0) {
          daPlaybackChunks.shift();
          daPlaybackChunkReadOffset = 0;
          continue;
        }
        const needed = out.length - writeIndex;
        const take = Math.min(needed, remaining);
        out.set(head.subarray(daPlaybackChunkReadOffset, daPlaybackChunkReadOffset + take), writeIndex);
        writeIndex += take;
        daPlaybackChunkReadOffset += take;
        if (daPlaybackChunkReadOffset >= head.length) {
          daPlaybackChunks.shift();
          daPlaybackChunkReadOffset = 0;
        }
      }
    };
    daPlayProcessorNode.connect(daPlayGainNode);
  }
}

function daAppendPcm(binary) {
  if (!daPlayAudioCtx) daInitPlaybackEngine();
  const samples = Math.floor(binary.byteLength / 2);
  if (samples <= 0) return;
  const src = new Int16Array(binary.buffer, binary.byteOffset, samples);
  const chunk = resampleInt16ToFloat32(src, UPLINK_SAMPLE_RATE, daPlayAudioCtx?.sampleRate || UPLINK_SAMPLE_RATE);
  if (chunk.length === 0) return;
  daPlaybackChunks.push(chunk);
  daWaveWrite = pushWaveSamples(daWaveBuffer, daWaveWrite, chunk);

  const sampleRate = daPlayAudioCtx?.sampleRate || UPLINK_SAMPLE_RATE;
  const maxSamples = Math.max(PLAYBACK_FRAME_SIZE, Math.round(sampleRate * (MAX_PLAYBACK_BUFFER_MS / 1000)));
  let buffered = -daPlaybackChunkReadOffset;
  for (const c of daPlaybackChunks) buffered += c.length;
  while (buffered > maxSamples && daPlaybackChunks.length > 0) {
    const dropped = daPlaybackChunks.shift();
    buffered -= dropped?.length || 0;
    daPlaybackChunkReadOffset = 0;
  }
}

function daCleanup() {
  if (daPlayProcessorNode) {
    daPlayProcessorNode.disconnect();
    daPlayProcessorNode.onaudioprocess = null;
    daPlayProcessorNode = null;
  }
  if (daPlayGainNode) {
    daPlayGainNode.disconnect();
    daPlayGainNode = null;
  }
  if (daPlayAudioCtx) {
    daPlayAudioCtx.close().catch(() => {});
    daPlayAudioCtx = null;
  }
  daStopLevelLoop();
  daClearPlayback();
}

function daConnect() {
  if (daWs && daWs.readyState === WebSocket.OPEN) return;
  daClearPlayback();
  daStartLevelLoop();
  // Create AudioContext inside click handler so the browser trusts the user gesture.
  daInitPlaybackEngine();
  if (daPlayAudioCtx?.state === "suspended") daPlayAudioCtx.resume();

  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  daWs = new WebSocket(`${proto}://${window.location.host}/api/clients/${encodeURIComponent(clientId)}/desktop-audio/ws`);
  daWs.binaryType = "arraybuffer";

  daWs.onopen = () => {
    daSetStatus("Connecting", "border-blue-700 bg-blue-900/40 text-blue-100");
    daConnectBtn.disabled = true;
    daDisconnectBtn.disabled = false;
    daWs.send(JSON.stringify({ type: "start" }));
  };

  daWs.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data);
        console.log("[desktop-audio] status message:", msg);
        if (msg?.type === "status") {
          if (msg.status === "offline") {
            daSetStatus("Client Offline", "border-amber-700 bg-amber-900/30 text-amber-200");
          } else if (msg.status === "connected") {
            daSetStatus("Listening", "border-emerald-700 bg-emerald-900/40 text-emerald-100");
          } else if (msg.status === "error") {
            daSetStatus("Error", "border-red-700 bg-red-900/40 text-red-100");
          }
        }
      } catch {}
      return;
    }
    const bytes = new Uint8Array(ev.data);
    if (bytes.byteLength > 1) daAppendPcm(bytes);
  };

  daWs.onclose = () => {
    daCleanup();
    daConnectBtn.disabled = false;
    daDisconnectBtn.disabled = true;
    daSetStatus("Disconnected", "border-slate-700 bg-slate-800 text-slate-300");
  };

  daWs.onerror = () => {
    daSetStatus("Error", "border-red-700 bg-red-900/40 text-red-100");
  };
}

function daDisconnect() {
  daCleanup();
  if (daWs) {
    try { daWs.send(JSON.stringify({ type: "stop" })); } catch {}
    try { daWs.close(); } catch {}
    daWs = null;
  }
  daConnectBtn.disabled = false;
  daDisconnectBtn.disabled = true;
  daSetStatus("Disconnected", "border-slate-700 bg-slate-800 text-slate-300");
}

daConnectBtn?.addEventListener("click", daConnect);
daDisconnectBtn?.addEventListener("click", daDisconnect);
daVolumeSlider?.addEventListener("input", () => {
  daGain = parseInt(daVolumeSlider.value, 10) / 100;
  if (daPlayGainNode) daPlayGainNode.gain.value = daGain;
  if (daVolumeLabel) daVolumeLabel.textContent = daVolumeSlider.value + "%";
});
window.addEventListener("beforeunload", daDisconnect);
drawWave(daWaveCanvas, daWaveBuffer, daWaveWrite, "rgba(251, 191, 36, 0.95)");
