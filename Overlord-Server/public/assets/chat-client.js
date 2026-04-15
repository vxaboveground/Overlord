const UNREAD_KEY = "overlord_chat_unread";
const MUTE_KEY = "overlord_chat_mute";

let ws = null;
let canWrite = false;
let currentUserId = 0;
let messageHandlers = new Set();
let unreadHandlers = new Set();
let statusHandlers = new Set();
let readyHandlers = new Set();

if (localStorage.getItem(UNREAD_KEY) === null) {
  localStorage.setItem(UNREAD_KEY, "0");
}
if (localStorage.getItem(MUTE_KEY) === null) {
  localStorage.setItem(MUTE_KEY, "none");
}

function emitStatus(status) {
  for (const handler of statusHandlers) {
    try { handler(status); } catch {}
  }
}

function emitReady(history, writable, userId) {
  canWrite = writable;
  currentUserId = userId || 0;
  for (const handler of readyHandlers) {
    try { handler(history, writable); } catch {}
  }
}

function emitMessage(msg) {
  for (const handler of messageHandlers) {
    try { handler(msg); } catch {}
  }
}

export function getUnreadCount() {
  return Number(localStorage.getItem(UNREAD_KEY) || "0");
}

export function setUnreadCount(value) {
  const next = Math.max(0, Number(value) || 0);
  localStorage.setItem(UNREAD_KEY, String(next));
  for (const handler of unreadHandlers) {
    try { handler(next); } catch {}
  }
}

export function incrementUnread() {
  setUnreadCount(getUnreadCount() + 1);
}

export function resetUnread() {
  setUnreadCount(0);
}

export function getMuteMode() {
  return localStorage.getItem(MUTE_KEY) || "none";
}

export function setMuteMode(mode) {
  const valid = ["none", "mute", "mute_collapse", "hide"];
  if (!valid.includes(mode)) return;
  localStorage.setItem(MUTE_KEY, mode);
}

let audioCtx = null;

function playNotificationSound() {
  const mute = getMuteMode();
  if (mute !== "none") return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.2);
  } catch {}
}

export function onMessage(cb) { messageHandlers.add(cb); return () => messageHandlers.delete(cb); }
export function onUnreadChanged(cb) { unreadHandlers.add(cb); return () => unreadHandlers.delete(cb); }
export function onStatusChanged(cb) { statusHandlers.add(cb); return () => statusHandlers.delete(cb); }
export function onReady(cb) { readyHandlers.add(cb); return () => readyHandlers.delete(cb); }

export function getCanWrite() { return canWrite; }

export function sendMessage(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (!canWrite) return false;
  const trimmed = (text || "").trim();
  if (!trimmed || trimmed.length > 2000) return false;
  ws.send(JSON.stringify({ type: "chat_send", message: trimmed }));
  return true;
}

export async function fetchHistory(before, limit = 50) {
  const params = new URLSearchParams();
  if (before) params.set("before", String(before));
  params.set("limit", String(limit));
  try {
    const res = await fetch(`/api/chat/history?${params.toString()}`);
    if (!res.ok) return { messages: [], canWrite: false };
    return await res.json();
  } catch {
    return { messages: [], canWrite: false };
  }
}

function handleWsMessage(payload) {
  if (!payload || typeof payload.type !== "string") return;

  if (payload.type === "chat_ready") {
    emitReady(payload.history || [], !!payload.canWrite, payload.userId);
    return;
  }

  if (payload.type === "chat_message") {
    emitMessage(payload);
    const isOwnMessage = currentUserId && payload.userId === currentUserId;
    if (!isOwnMessage) {
      const mute = getMuteMode();
      if (mute === "none") {
        incrementUnread();
        playNotificationSound();
      }
    }
    return;
  }

  if (payload.type === "chat_error") {
    console.warn("[chat] server error:", payload.error);
  }
}

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/api/chat/ws`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    emitStatus("connected");
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      try {
        handleWsMessage(JSON.parse(event.data));
      } catch {}
      return;
    }
  };

  ws.onerror = () => {
    emitStatus("error");
  };

  ws.onclose = () => {
    emitStatus("disconnected");
    setTimeout(connect, 3000);
  };
}

let started = false;

export function start() {
  if (started) return;
  started = true;
  connect();
}
