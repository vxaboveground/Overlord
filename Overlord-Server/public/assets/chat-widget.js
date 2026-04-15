import * as chatClient from "./chat-client.js";

let panelOpen = false;
let initialized = false;
let bubble = null;
let panel = null;
let messageList = null;
let inputArea = null;
let sendBtn = null;
let muteDropdown = null;
let muteDropdownMenu = null;
let muteDropdownLabel = null;
let oldestTimestamp = null;
let loadingMore = false;
let hasMore = true;

const ROLE_COLORS = {
  admin: "bg-rose-500/80 text-white",
  operator: "bg-sky-500/80 text-white",
  viewer: "bg-zinc-500/80 text-white",
};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function createMessageEl(msg) {
  const wrapper = document.createElement("div");
  wrapper.className = "flex flex-col gap-0.5 px-3 py-1.5 hover:bg-zinc-800/40 transition-colors";
  wrapper.dataset.msgId = msg.id;
  wrapper.dataset.ts = msg.createdAt;

  const header = document.createElement("div");
  header.className = "flex items-center gap-2 text-xs";

  const badge = document.createElement("span");
  badge.className = `px-1.5 py-0.5 rounded text-[10px] font-medium ${ROLE_COLORS[msg.userRole] || ROLE_COLORS.viewer}`;
  badge.textContent = msg.userRole;

  const name = document.createElement("span");
  name.className = "font-semibold text-slate-200";
  name.textContent = msg.username;

  const onlineCount = typeof msg.onlineClients === "number" ? msg.onlineClients : 0;
  const clientsBadge = document.createElement("span");
  clientsBadge.className = "px-1.5 py-0.5 rounded text-[10px] font-medium " +
    (onlineCount > 0 ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-zinc-700/50 text-zinc-500");
  clientsBadge.textContent = onlineCount > 0 ? `${onlineCount} online` : "0 online";

  const time = document.createElement("span");
  time.className = "text-slate-500 ml-auto whitespace-nowrap";
  time.textContent = formatTime(msg.createdAt);

  header.appendChild(badge);
  header.appendChild(name);
  header.appendChild(clientsBadge);
  header.appendChild(time);

  const body = document.createElement("div");
  body.className = "text-sm text-slate-300 break-words whitespace-pre-wrap pl-0.5";
  body.textContent = msg.message;

  wrapper.appendChild(header);
  wrapper.appendChild(body);
  return wrapper;
}

function scrollToBottom() {
  if (messageList) {
    messageList.scrollTop = messageList.scrollHeight;
  }
}

function updateBubbleBadge() {
  if (!bubble) return;
  const count = chatClient.getUnreadCount();
  const badge = bubble.querySelector("[data-chat-badge]");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function updateMuteVisibility() {
  const mute = chatClient.getMuteMode();
  if (!bubble || !panel) return;

  if (mute === "hide") {
    bubble.classList.add("hidden");
    panel.classList.add("hidden");
    panelOpen = false;
  } else {
    bubble.classList.remove("hidden");
  }

  if (mute === "mute_collapse" && panelOpen) {
    // auto collapse handled on new messages
  }
}

function togglePanel() {
  if (!panel) return;
  panelOpen = !panelOpen;
  if (panelOpen) {
    panel.classList.remove("hidden");
    panel.style.opacity = "0";
    panel.style.transform = "translateY(10px) scale(0.98)";
    requestAnimationFrame(() => {
      panel.style.transition = "opacity 0.15s ease, transform 0.15s ease";
      panel.style.opacity = "1";
      panel.style.transform = "translateY(0) scale(1)";
    });
    chatClient.resetUnread();
    updateBubbleBadge();
    scrollToBottom();
    if (inputArea) inputArea.focus();
  } else {
    panel.style.transition = "opacity 0.1s ease, transform 0.1s ease";
    panel.style.opacity = "0";
    panel.style.transform = "translateY(10px) scale(0.98)";
    setTimeout(() => {
      if (!panelOpen) panel.classList.add("hidden");
    }, 100);
  }
}

async function loadMoreHistory() {
  if (loadingMore || !hasMore || !messageList) return;
  loadingMore = true;

  const result = await chatClient.fetchHistory(oldestTimestamp, 50);
  const msgs = result.messages || [];
  if (msgs.length === 0) {
    hasMore = false;
    loadingMore = false;
    return;
  }

  const prevHeight = messageList.scrollHeight;
  const prevTop = messageList.scrollTop;

  const frag = document.createDocumentFragment();
  for (const msg of msgs) {
    frag.appendChild(createMessageEl(msg));
    if (!oldestTimestamp || msg.createdAt < oldestTimestamp) {
      oldestTimestamp = msg.createdAt;
    }
  }

  messageList.insertBefore(frag, messageList.firstChild);

  const newHeight = messageList.scrollHeight;
  messageList.scrollTop = prevTop + (newHeight - prevHeight);

  if (msgs.length < 50) hasMore = false;
  loadingMore = false;
}

function appendMessage(msg) {
  if (!messageList) return;
  const wasAtBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 40;
  messageList.appendChild(createMessageEl(msg));
  if (!oldestTimestamp || msg.createdAt < oldestTimestamp) {
    oldestTimestamp = msg.createdAt;
  }
  if (wasAtBottom) scrollToBottom();
}

function handleSend() {
  if (!inputArea) return;
  const text = inputArea.value;
  if (chatClient.sendMessage(text)) {
    inputArea.value = "";
    inputArea.style.height = "auto";
  }
}

function createWidget() {
  bubble = document.createElement("div");
  bubble.id = "chat-bubble";
  bubble.className = "fixed bottom-5 right-5 z-[9998] cursor-pointer select-none";
  bubble.innerHTML = `
    <div class="relative flex items-center justify-center w-12 h-12 rounded-full bg-sky-600 hover:bg-sky-500 shadow-lg shadow-sky-900/30 transition-colors">
      <i class="fa-solid fa-comments text-white text-lg"></i>
      <span data-chat-badge class="hidden absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-rose-500 text-white text-xs flex items-center justify-center font-semibold"></span>
    </div>
  `;
  bubble.addEventListener("click", togglePanel);

  panel = document.createElement("div");
  panel.id = "chat-panel";
  panel.className = "hidden fixed bottom-[4.5rem] right-5 z-[9998] w-[360px] max-h-[500px] flex flex-col rounded-xl border border-zinc-700/70 bg-zinc-900/95 backdrop-blur-md shadow-2xl shadow-black/40 overflow-hidden";
  panel.innerHTML = `
    <div class="flex items-center justify-between px-4 py-2.5 border-b border-zinc-700/60 bg-zinc-800/60 shrink-0">
      <div class="flex items-center gap-2">
        <i class="fa-solid fa-comments text-sky-400 text-sm"></i>
        <span class="font-semibold text-slate-200 text-sm">Team Chat</span>
      </div>
      <div class="flex items-center gap-2">
        <div id="chat-mute-dropdown" class="relative">
          <button id="chat-mute-btn" class="flex items-center gap-1.5 bg-zinc-700/70 border border-zinc-600 text-slate-300 text-xs rounded px-2 py-1 outline-none cursor-pointer hover:bg-zinc-600/70 transition-colors" title="Notification mode">
            <span id="chat-mute-label">All notifications</span>
            <i class="fa-solid fa-chevron-down text-[10px] text-slate-400"></i>
          </button>
          <div id="chat-mute-menu" class="hidden absolute right-0 top-full mt-1 w-44 bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl shadow-black/50 py-1 z-[9999]">
            <div class="chat-mute-option px-3 py-1.5 text-xs text-slate-300 hover:bg-zinc-700 cursor-pointer transition-colors" data-value="none">All notifications</div>
            <div class="chat-mute-option px-3 py-1.5 text-xs text-slate-300 hover:bg-zinc-700 cursor-pointer transition-colors" data-value="mute">Mute</div>
            <div class="chat-mute-option px-3 py-1.5 text-xs text-slate-300 hover:bg-zinc-700 cursor-pointer transition-colors" data-value="mute_collapse">Mute + Collapse</div>
            <div class="chat-mute-option px-3 py-1.5 text-xs text-slate-300 hover:bg-zinc-700 cursor-pointer transition-colors" data-value="hide">Hide</div>
          </div>
        </div>
        <button id="chat-close-btn" class="text-slate-400 hover:text-slate-200 transition-colors" title="Close">
          <i class="fa-solid fa-xmark text-sm"></i>
        </button>
      </div>
    </div>
    <div id="chat-messages" class="flex-1 overflow-y-auto min-h-0 py-1" style="max-height: 370px;"></div>
    <div id="chat-input-area" class="hidden shrink-0 border-t border-zinc-700/60 bg-zinc-800/40 p-2">
      <div class="flex items-end gap-2">
        <textarea id="chat-input" rows="1" maxlength="2000"
          class="flex-1 bg-zinc-800 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 outline-none resize-none leading-snug"
          placeholder="Type a message..." style="max-height: 100px;"></textarea>
        <button id="chat-send-btn" class="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors shrink-0" title="Send">
          <i class="fa-solid fa-paper-plane"></i>
        </button>
      </div>
    </div>
    <div id="chat-readonly-bar" class="hidden shrink-0 border-t border-zinc-700/60 bg-zinc-800/40 px-3 py-2">
      <span class="text-xs text-slate-500 italic">Read-only &mdash; you can view but not send messages</span>
    </div>
  `;

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  messageList = panel.querySelector("#chat-messages");
  inputArea = panel.querySelector("#chat-input");
  sendBtn = panel.querySelector("#chat-send-btn");
  muteDropdown = panel.querySelector("#chat-mute-dropdown");
  muteDropdownMenu = panel.querySelector("#chat-mute-menu");
  muteDropdownLabel = panel.querySelector("#chat-mute-label");

  const closeBtn = panel.querySelector("#chat-close-btn");
  const inputContainer = panel.querySelector("#chat-input-area");
  const readonlyBar = panel.querySelector("#chat-readonly-bar");

  const MUTE_LABELS = {
    none: "All notifications",
    mute: "Mute",
    mute_collapse: "Mute + Collapse",
    hide: "Hide",
  };

  muteDropdownLabel.textContent = MUTE_LABELS[chatClient.getMuteMode()] || MUTE_LABELS.none;

  panel.querySelector("#chat-mute-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    muteDropdownMenu.classList.toggle("hidden");
  });

  muteDropdownMenu.querySelectorAll(".chat-mute-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      const value = opt.dataset.value;
      chatClient.setMuteMode(value);
      muteDropdownLabel.textContent = MUTE_LABELS[value] || MUTE_LABELS.none;
      muteDropdownMenu.classList.add("hidden");
      updateMuteVisibility();
    });
  });

  document.addEventListener("click", () => {
    if (muteDropdownMenu && !muteDropdownMenu.classList.contains("hidden")) {
      muteDropdownMenu.classList.add("hidden");
    }
  });

  closeBtn.addEventListener("click", () => {
    if (panelOpen) togglePanel();
  });

  sendBtn.addEventListener("click", handleSend);

  inputArea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  inputArea.addEventListener("input", () => {
    inputArea.style.height = "auto";
    inputArea.style.height = Math.min(inputArea.scrollHeight, 100) + "px";
  });

  messageList.addEventListener("scroll", () => {
    if (messageList.scrollTop < 40 && hasMore && !loadingMore) {
      loadMoreHistory();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panelOpen) {
      togglePanel();
    }
  });

  document.addEventListener("mousedown", (e) => {
    if (panelOpen && !panel.contains(e.target) && !bubble.contains(e.target)) {
      togglePanel();
    }
  });

  chatClient.onReady((history, writable) => {
    messageList.innerHTML = "";
    oldestTimestamp = null;
    hasMore = true;

    for (const msg of history) {
      messageList.appendChild(createMessageEl(msg));
      if (!oldestTimestamp || msg.createdAt < oldestTimestamp) {
        oldestTimestamp = msg.createdAt;
      }
    }
    scrollToBottom();

    if (writable) {
      inputContainer.classList.remove("hidden");
      readonlyBar.classList.add("hidden");
    } else {
      inputContainer.classList.add("hidden");
      readonlyBar.classList.remove("hidden");
    }
  });

  chatClient.onMessage((msg) => {
    appendMessage(msg);
    const mute = chatClient.getMuteMode();
    if (panelOpen) {
      chatClient.resetUnread();
      updateBubbleBadge();
    }
    if (mute === "mute_collapse" && panelOpen) {
      togglePanel();
    }
  });

  chatClient.onUnreadChanged(() => {
    updateBubbleBadge();
  });

  updateBubbleBadge();
  updateMuteVisibility();

  chatClient.start();
}

export function init() {
  if (initialized) return;
  initialized = true;
  createWidget();
}

export function show() {
  if (chatClient.getMuteMode() === "hide") {
    chatClient.setMuteMode("none");
  }
  if (bubble) bubble.classList.remove("hidden");
  updateMuteVisibility();
}

export function isHidden() {
  return chatClient.getMuteMode() === "hide";
}
