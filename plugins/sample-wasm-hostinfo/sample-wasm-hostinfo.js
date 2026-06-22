(() => {
  const out = document.getElementById("sample-wasm-hostinfo-output");
  const btn = document.getElementById("sample-wasm-hostinfo-run");
  const status = document.getElementById("sample-wasm-hostinfo-status");
  const fields = {
    clientId: document.getElementById("sample-wasm-hostinfo-client"),
    version: document.getElementById("sample-wasm-hostinfo-version"),
    os: document.getElementById("sample-wasm-hostinfo-os"),
    arch: document.getElementById("sample-wasm-hostinfo-arch"),
  };
  const clientId = new URLSearchParams(window.location.search).get("clientId");
  const pluginId = "sample-wasm-hostinfo";
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

  function renderHostInfo(payload) {
    const info = parsePayload(payload);
    if (info.error) {
      setStatus(info.error);
      log(JSON.stringify(info, null, 2));
      return;
    }
    if (fields.clientId) fields.clientId.textContent = info.clientId || "-";
    if (fields.version) fields.version.textContent = info.version || "-";
    if (fields.os) fields.os.textContent = info.os || "-";
    if (fields.arch) fields.arch.textContent = info.arch || "-";
    setStatus("Host info received");
    log(JSON.stringify(info, null, 2));
  }

  function handlePluginEvent(event, payload) {
    if (event === "ready" || event === "host_info") renderHostInfo(payload);
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
    setStatus("Requesting host info");
    const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/plugins/sample-wasm-hostinfo/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "query_host", payload: {} }),
    });
    if (!res.ok) setStatus(`Send failed: ${res.status}`);
    setTimeout(pollEvents, 250);
  });

  if (clientId) {
    setInterval(pollEvents, 1500);
    setTimeout(pollEvents, 300);
  }
})();
