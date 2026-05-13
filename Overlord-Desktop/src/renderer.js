const { invoke } = window.__TAURI__.core;

const form = document.getElementById("connect-form");
const hostInput = document.getElementById("host");
const portInput = document.getElementById("port");
const tlsCheckbox = document.getElementById("use-tls");
const connectBtn = document.getElementById("connect-btn");
const statusEl = document.getElementById("status");

function setStatus(msg, type = "info") {
  statusEl.className = `status ${type}`;
  statusEl.innerHTML = msg;
}

(async () => {
  try {
    const saved = await invoke("get_saved_connection");
    if (saved) {
      hostInput.value = saved.host;
      portInput.value = String(saved.port);
      tlsCheckbox.checked = saved.useTls;
    }
  } catch { }

  try {
    const err = await invoke("get_pending_error");
    if (err) setStatus(err, "error");
  } catch { }
})();

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const host = hostInput.value.trim();
  const port = parseInt(portInput.value, 10);
  const useTls = tlsCheckbox.checked;

  if (!host) {
    setStatus("Please enter a host address.", "error");
    return;
  }
  if (isNaN(port) || port < 1 || port > 65535) {
    setStatus("Port must be between 1 and 65535.", "error");
    return;
  }

  connectBtn.disabled = true;
  connectBtn.querySelector(".btn-text").textContent = "Connecting…";
  setStatus('<span class="spinner"></span> Connecting…', "info");

  try {
    const result = await invoke("connect_to_server", { host, port, useTls });

    if (result.success) {
      setStatus("Connected! Loading Overlord…", "ok");
    } else {
      setStatus(result.error || "Connection failed.", "error");
      connectBtn.disabled = false;
      connectBtn.querySelector(".btn-text").textContent = "Connect";
    }
  } catch (err) {
    setStatus(err?.message || String(err) || "Connection failed.", "error");
    connectBtn.disabled = false;
    connectBtn.querySelector(".btn-text").textContent = "Connect";
  }
});
