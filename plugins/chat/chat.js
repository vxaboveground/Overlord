(() => {
  const PLUGIN_ID = "chat";
  const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;

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
  const btnAttach       = document.getElementById("btn-attach");
  const fileInput       = document.getElementById("file-input");
  const configToggle    = document.getElementById("config-toggle");
  const configBody      = document.getElementById("config-body");

  let chatOpen = false;
  let sseStream = null;
  const attachmentUrlCache = new Map();

  clientIdInput.value = params.get("clientId") || "";

  function getClientId() {
    return clientIdInput.value.trim();
  }

  function setStatus(open) {
    chatOpen = open;
    statusDot.className = "chat-status-dot" + (open ? " open" : "");
    statusText.textContent = open ? "Chat is open" : "Chat not opened";
    btnOpen.disabled   = open;
    btnClose.disabled  = !open;
    msgInput.disabled  = !open;
    btnSend.disabled   = !open;
    btnAttach.disabled = !open;
    if (open) msgInput.focus();
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = r.result;
        const i = s.indexOf(",");
        resolve(i < 0 ? s : s.slice(i + 1));
      };
      r.onerror = () => reject(r.error || new Error("read failed"));
      r.readAsDataURL(file);
    });
  }

  async function loadAttachmentBlob(id) {
    if (attachmentUrlCache.has(id)) return attachmentUrlCache.get(id);
    const { ok, result } = await rpc("get_attachment", { id });
    if (!ok || !result?.dataB64) return null;
    const bin = atob(result.dataB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], {
      type: result.mime || "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    attachmentUrlCache.set(id, url);
    return url;
  }

  function renderAttachment(att, messageId) {
    const wrap = document.createElement("div");
    wrap.className = "chat-msg-attachment";
    const isImage = (att.mime || "").startsWith("image/");

    if (isImage) {
      const img = document.createElement("img");
      img.className = "chat-msg-image";
      img.alt = att.name;
      img.title = `${att.name} (${humanSize(att.size)})`;
      loadAttachmentBlob(messageId).then((url) => {
        if (url) img.src = url;
      });
      img.addEventListener("click", async () => {
        const url = await loadAttachmentBlob(messageId);
        if (url) window.open(url, "_blank");
      });
      wrap.appendChild(img);
    } else {
      const link = document.createElement("a");
      link.className = "chat-msg-file";
      link.href = "#";
      link.innerHTML = `<i class="fa-solid fa-file"></i> <span class="chat-msg-file-name"></span> <span class="chat-msg-file-size"></span>`;
      link.querySelector(".chat-msg-file-name").textContent = att.name;
      link.querySelector(".chat-msg-file-size").textContent = `(${humanSize(att.size)})`;
      link.addEventListener("click", async (e) => {
        e.preventDefault();
        const url = await loadAttachmentBlob(messageId);
        if (!url) return;
        const a = document.createElement("a");
        a.href = url;
        a.download = att.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
      wrap.appendChild(link);
    }
    return wrap;
  }

  function appendMessage(msg) {
    const isOut = msg.direction === "to_target";
    const div = document.createElement("div");
    div.className = "chat-msg " + (isOut ? "outgoing" : "incoming");

    const senderDiv = document.createElement("div");
    senderDiv.className = "chat-msg-sender";
    senderDiv.textContent = msg.sender;
    div.appendChild(senderDiv);

    if (msg.text) {
      const textDiv = document.createElement("div");
      textDiv.className = "chat-msg-text";
      textDiv.textContent = msg.text;
      div.appendChild(textDiv);
    }

    if (msg.attachment) {
      div.appendChild(renderAttachment(msg.attachment, msg.id));
    }

    const timeDiv = document.createElement("div");
    timeDiv.className = "chat-msg-time";
    timeDiv.textContent = formatTime(msg.timestamp || Date.now());
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
    for (const url of attachmentUrlCache.values()) URL.revokeObjectURL(url);
    attachmentUrlCache.clear();
    messagesEl.innerHTML = "";
    for (const m of result) appendMessage(m);
  }

  function connectSSE() {
    if (sseStream) sseStream.close();
    sseStream = new EventSource(`/api/plugins/${PLUGIN_ID}/stream`);

    sseStream.addEventListener("new_message", (e) => {
      const data = JSON.parse(e.data);
      if (data.clientId !== getClientId()) return;
      appendMessage(data);
    });

    sseStream.addEventListener("chat_status", (e) => {
      const data = JSON.parse(e.data);
      if (data.clientId !== getClientId()) return;
      setStatus(data.status === "opened");
    });

    sseStream.addEventListener("history_cleared", (e) => {
      const data = JSON.parse(e.data);
      if (data.clientId !== getClientId()) return;
      for (const url of attachmentUrlCache.values()) URL.revokeObjectURL(url);
      attachmentUrlCache.clear();
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
      appendMessage({
        sender: "System",
        text: "Failed to send: " + err.message,
        direction: "from_target",
        timestamp: Date.now(),
      });
    }
  });

  msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      btnSend.click();
    }
  });

  btnAttach.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    if (file.size > MAX_ATTACHMENT_SIZE) {
      alert(`File is too large (${humanSize(file.size)}). Max is ${humanSize(MAX_ATTACHMENT_SIZE)}.`);
      return;
    }
    const cid = getClientId();
    if (!cid) { alert("Enter a Client ID first."); return; }

    const sender = operatorNameIn.value.trim() || "Operator";
    const prevDisabled = btnAttach.disabled;
    btnAttach.disabled = true;
    try {
      const dataB64 = await readFileAsBase64(file);
      const mime = file.type || "application/octet-stream";
      await rpc("store_attachment", {
        clientId: cid,
        sender,
        name: file.name,
        mime,
        dataB64,
      });
      await sendPluginEvent(cid, "chat_attachment", {
        from: sender,
        name: file.name,
        mime,
        dataB64,
      });
    } catch (err) {
      appendMessage({
        sender: "System",
        text: "Failed to send file: " + err.message,
        direction: "from_target",
        timestamp: Date.now(),
      });
    } finally {
      btnAttach.disabled = prevDisabled;
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
