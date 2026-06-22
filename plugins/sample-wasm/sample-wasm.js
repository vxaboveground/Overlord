(() => {
  const out = document.getElementById("sample-wasm-output");
  const btn = document.getElementById("sample-wasm-run");
  const clientId = new URLSearchParams(window.location.search).get("clientId");

  function log(message) {
    if (out) out.textContent = `${new Date().toLocaleTimeString()} ${message}\n${out.textContent || ""}`;
  }

  btn?.addEventListener("click", async () => {
    if (!clientId) {
      log("Open this plugin from a client row so clientId is present.");
      return;
    }
    const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/plugins/sample-wasm/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "run_sample", payload: { note: "hello from UI" } }),
    });
    log(res.ok ? "sent run_sample" : `send failed: ${res.status}`);
  });
})();
