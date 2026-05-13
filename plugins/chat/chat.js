(() => {
  const PLUGIN_ID = "chat";
  const params = new URLSearchParams(window.location.search);

  const clientIdInput   = document.getElementById("client-id");
  const operatorNameIn  = document.getElementById("operator-name");
  const targetNameIn    = document.getElementById("target-name");
  const windowTitleIn   = document.getElementById("window-title");
  const optClosable     = document.getElementById("opt-closable");
  const optOnTop        = document.getElementById("opt-ontop");
  const btnOpen         = document.getElementById("btn-open");
  const btnClose        = document.getElementById("btn-close");
  const btnClear        = document.getElementById("btn-clear");
  const statusDot       = document.getElementById("status-dot");
  const statusText      = document.getElementById("status-text");
  const messagesEl      = document.getElementById("messages");
  const msgInput        = document.getElementById("msg-input");
  const btnSend         = document.getElementById("btn-send");
  const configToggle    = document.getElementById("config-toggle");
  const configBody      = document.getElementById("config-body");

  let chatOpen = false;
  let sseStream = null;

  clientIdInput.value = params.get("clientId") || "";

  function getClientId() {
    return clientIdInput.value.trim();
  }

  function setStatus(open) {
    chatOpen = open;
    statusDot.className = "chat-status-dot" + (open ? " open" : "");
    statusText.textContent = open ? "Chat is open" : "Chat not opened";
    btnOpen.disabled  = open;
    btnClose.disabled = !open;
    msgInput.disabled = !open;
    btnSend.disabled  = !open;
    if (open) msgInput.focus();
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function appendMessage(sender, text, direction, timestamp) {
    const isOut = direction === "to_target";
    const div = document.createElement("div");
    div.className = "chat-msg " + (isOut ? "outgoing" : "incoming");

    const senderDiv = document.createElement("div");
    senderDiv.className = "chat-msg-sender";
    senderDiv.textContent = sender;

    const textDiv = document.createElement("div");
    textDiv.className = "chat-msg-text";
    textDiv.textContent = text;

    const timeDiv = document.createElement("div");
    timeDiv.className = "chat-msg-time";
    timeDiv.textContent = formatTime(timestamp || Date.now());

    div.appendChild(senderDiv);
    div.appendChild(textDiv);
    div.appendChild(timeDiv);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function rpc(method, rpcParams) {
    const res = await fetch(`/api/plugins/${PLUGIN_ID}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params: rpcParams }),
    });
    return res.json();
  }

  async function sendPluginEvent(clientId, event, payload) {
    const res = await fetch(
      `/api/clients/${encodeURIComponent(clientId)}/plugins/${PLUGIN_ID}/event`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, payload }),
      }
    );
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Event failed: ${res.status} ${t}`);
    }
  }

  async function loadHistory() {
    const cid = getClientId();
    if (!cid) return;
    const { ok, result } = await rpc("get_history", { clientId: cid });
    if (!ok || !result) return;
    messagesEl.innerHTML = "";
    for (const m of result) {
      appendMessage(m.sender, m.text, m.direction, m.timestamp);
    }
  }

  function connectSSE() {
    if (sseStream) sseStream.close();
    sseStream = new EventSource(`/api/plugins/${PLUGIN_ID}/stream`);

    sseStream.addEventListener("new_message", (e) => {
      const data = JSON.parse(e.data);
      if (data.clientId !== getClientId()) return;
      appendMessage(data.sender, data.text, data.direction, data.timestamp);
    });

    sseStream.addEventListener("chat_status", (e) => {
      const data = JSON.parse(e.data);
      if (data.clientId !== getClientId()) return;
      setStatus(data.status === "opened");
    });

    sseStream.addEventListener("history_cleared", (e) => {
      const data = JSON.parse(e.data);
      if (data.clientId !== getClientId()) return;
      messagesEl.innerHTML = "";
    });
  }

  // --- Event handlers ---

  btnOpen.addEventListener("click", async () => {
    const cid = getClientId();
    if (!cid) { alert("Enter a Client ID first."); return; }
    try {
      await sendPluginEvent(cid, "open_chat", {
        operatorName: operatorNameIn.value.trim() || "Operator",
        targetName:   targetNameIn.value.trim()   || "User",
        title:        windowTitleIn.value.trim()   || "Chat",
        closable:     optClosable.checked,
        alwaysOnTop:  optOnTop.checked,
      });
      setStatus(true);
      loadHistory();
      connectSSE();
    } catch (err) {
      alert("Failed to open chat: " + err.message);
    }
  });

  btnClose.addEventListener("click", async () => {
    const cid = getClientId();
    if (!cid) return;
    try {
      await sendPluginEvent(cid, "close_chat", {});
      setStatus(false);
    } catch (err) {
      alert("Failed to close chat: " + err.message);
    }
  });

  btnSend.addEventListener("click", async () => {
    const cid = getClientId();
    const text = msgInput.value.trim();
    if (!cid || !text) return;

    const sender = operatorNameIn.value.trim() || "Operator";
    msgInput.value = "";
    msgInput.focus();

    try {
      await rpc("store_message", { clientId: cid, sender, text });
      await sendPluginEvent(cid, "chat_message", { from: sender, text });
    } catch (err) {
      appendMessage("System", "Failed to send: " + err.message, "from_target", Date.now());
    }
  });

  msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      btnSend.click();
    }
  });

  btnClear.addEventListener("click", async () => {
    const cid = getClientId();
    if (!cid) return;
    await rpc("clear_history", { clientId: cid });
  });

  configToggle.addEventListener("click", () => {
    configToggle.classList.toggle("collapsed");
    configBody.classList.toggle("hidden");
  });

  // --- Init ---

  if (getClientId()) {
    loadHistory();
    connectSSE();
  }
})();
