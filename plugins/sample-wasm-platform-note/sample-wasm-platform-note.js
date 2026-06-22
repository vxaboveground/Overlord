(() => {
  const out = document.getElementById("sample-wasm-platform-note-output");
  const btn = document.getElementById("sample-wasm-platform-note-run");
  const status = document.getElementById("sample-wasm-platform-note-status");
  const fields = {
    os: document.getElementById("sample-wasm-platform-note-os"),
    arch: document.getElementById("sample-wasm-platform-note-arch"),
    mkdir: document.getElementById("sample-wasm-platform-note-mkdir"),
    write: document.getElementById("sample-wasm-platform-note-write"),
  };
  const clientId = new URLSearchParams(window.location.search).get("clientId");
  const pluginId = "sample-wasm-platform-note";
  let polling = false;

  function log(message) {
    if (out) out.textContent = `${message}\n${out.textContent || ""}`;
  }

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  function parsePayload(payload) {
    if (payload == null) return {};
    if (typeof payload === "string") {
      try { return JSON.parse(payload); } catch (_) { return { raw: payload }; }
    }
    return payload;
  }

  function renderPlatformNote(payload) {
    const info = parsePayload(payload);
    if (fields.os) fields.os.textContent = info.os || "-";
    if (fields.arch) fields.arch.textContent = info.arch || "-";
    if (fields.mkdir) fields.mkdir.textContent = String(info.mkdir ?? "-");
    if (fields.write) fields.write.textContent = String(info.write ?? "-");
    setStatus(info.write === 0 ? "Platform note written" : "Platform note result received");
    log(JSON.stringify(info, null, 2));
  }

  function handlePluginEvent(event, payload) {
    if (event === "ready") {
      setStatus("Plugin loaded");
      log(JSON.stringify(parsePayload(payload), null, 2));
      return;
    }
    if (event === "platform_note") renderPlatformNote(payload);
  }

  window.addEventListener("message", (e) => {
    if (!e.data || e.data.type !== "plugin_event") return;
    if (e.data.pluginId && e.data.pluginId !== pluginId) return;
    handlePluginEvent(e.data.event, e.data.payload);
  });

  async function pollEvents() {
    if (!clientId || polling) return;
    polling = true;
    try {
      const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/plugins/${pluginId}/events`, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.events) data.events.forEach((e) => handlePluginEvent(e.event, e.payload));
      }
    } catch (_) {
      // Polling is best-effort; the next interval can recover.
    } finally {
      polling = false;
    }
  }

  btn?.addEventListener("click", async () => {
    if (!clientId) {
      setStatus("Open this plugin from a client row so clientId is present.");
      return;
    }
    setStatus("Writing platform note");
    const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/plugins/sample-wasm-platform-note/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "write_note", payload: {} }),
    });
    if (!res.ok) setStatus(`Send failed: ${res.status}`);
    setTimeout(pollEvents, 250);
  });

  if (clientId) {
    setInterval(pollEvents, 1500);
    setTimeout(pollEvents, 300);
  }
})();
