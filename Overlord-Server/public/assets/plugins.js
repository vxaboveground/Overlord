const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const pluginList = document.getElementById("plugin-list");
const refreshBtn = document.getElementById("refresh-btn");
const uploadStatus = document.getElementById("upload-status");
const PLUGIN_CACHE_INVALIDATION_KEY = "overlord_plugin_cache_invalidated_at";

function notifyPluginsChanged() {
  try {
    localStorage.setItem(PLUGIN_CACHE_INVALIDATION_KEY, String(Date.now()));
  } catch {}
  window.dispatchEvent(new CustomEvent("overlord:plugins-changed"));
}

async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    if (!res.ok) {
      window.location.href = "/";
      return;
    }

    const data = await res.json();
    const usernameDisplay = document.getElementById("username-display");
    const roleBadge = document.getElementById("role-badge");
    if (usernameDisplay) {
      usernameDisplay.textContent = data.username;
    }

    if (roleBadge) {
      const roleBadges = {
        admin: '<i class="fa-solid fa-crown mr-1"></i>Admin',
        operator: '<i class="fa-solid fa-sliders mr-1"></i>Operator',
        viewer: '<i class="fa-solid fa-eye mr-1"></i>Viewer',
      };
      if (roleBadges[data.role]) {
        roleBadge.innerHTML = roleBadges[data.role];
      } else {
        roleBadge.textContent = data.role || "";
      }

      if (data.role === "admin") {
        roleBadge.classList.add(
          "bg-purple-900/50",
          "text-purple-300",
          "border",
          "border-purple-800",
        );
      } else if (data.role === "operator") {
        roleBadge.classList.add(
          "bg-blue-900/50",
          "text-blue-300",
          "border",
          "border-blue-800",
        );
      } else {
        roleBadge.classList.add(
          "bg-slate-700",
          "text-slate-300",
          "border",
          "border-slate-600",
        );
      }
    }

    if (data.role === "admin") {
      document.getElementById("build-link")?.classList.remove("hidden");
      document.getElementById("users-link")?.classList.remove("hidden");
      document.getElementById("plugins-link")?.classList.remove("hidden");
      document.getElementById("deploy-link")?.classList.remove("hidden");
    } else if (data.role === "operator" || data.canBuild) {
      document.getElementById("build-link")?.classList.remove("hidden");
    }

    if (data.role !== "viewer") {
      document.getElementById("scripts-link")?.classList.remove("hidden");
    }
  } catch (err) {
    console.error("Auth check failed:", err);
    window.location.href = "/";
  }
}

function setStatus(text, isError = false) {
  uploadStatus.textContent = text;
  uploadStatus.className = `mt-3 text-sm ${isError ? "text-red-400" : "text-slate-400"}`;
}

async function fetchPlugins() {
  const res = await fetch("/api/plugins");
  if (!res.ok) {
    setStatus("Failed to load plugins", true);
    return [];
  }
  const data = await res.json();
  return Array.isArray(data.plugins) ? data.plugins : [];
}

function getTrustBadge(sig) {
  if (!sig) return { icon: "fa-shield-halved", color: "text-orange-400 border-orange-600 bg-orange-900/30", label: "Unsigned", tooltip: "This plugin is not signed" };
  if (sig.signed && !sig.valid) return { icon: "fa-shield-xmark", color: "text-red-400 border-red-600 bg-red-900/30", label: "Invalid", tooltip: "Signature verification failed — plugin may be tampered" };
  if (sig.signed && sig.valid && sig.trusted) return { icon: "fa-shield-check", color: "text-emerald-400 border-emerald-600 bg-emerald-900/30", label: "Trusted", tooltip: `Signed by trusted key: ${sig.fingerprint || "unknown"}` };
  if (sig.signed && sig.valid && !sig.trusted) return { icon: "fa-shield", color: "text-yellow-400 border-yellow-600 bg-yellow-900/30", label: "Untrusted", tooltip: `Signed but key not trusted: ${sig.fingerprint || "unknown"}` };
  return { icon: "fa-shield-halved", color: "text-orange-400 border-orange-600 bg-orange-900/30", label: "Unsigned", tooltip: "This plugin is not signed" };
}

function describeNeeds(needs) {
  const files = Array.isArray(needs?.files) ? needs.files : [];
  if (!files.length) return [];
  return files.map((need) => {
    const access = Array.isArray(need.access) ? need.access.join(", ") : "";
    const reason = need.reason ? ` - ${need.reason}` : "";
    return `${need.bucket}: ${access}${reason}`;
  });
}

function renderPlugins(plugins) {
  pluginList.innerHTML = "";
  if (!plugins.length) {
    pluginList.innerHTML =
      '<div class="text-slate-400">No plugins installed.</div>';
    return;
  }
  for (const plugin of plugins) {
    const isServerOnly = plugin.runtime === "server";
    const card = document.createElement("div");
    card.className =
      isServerOnly
        ? "rounded-xl border border-fuchsia-800/60 bg-fuchsia-950/20 px-4 py-3 flex items-center justify-between"
        : "rounded-xl border border-slate-800 bg-slate-950/50 px-4 py-3 flex items-center justify-between";
    const meta = document.createElement("div");
    const titleRow = document.createElement("div");
    titleRow.className = "flex items-center gap-2";
    const title = document.createElement("span");
    title.className = "font-semibold";
    title.textContent = plugin.name || plugin.id;
    titleRow.appendChild(title);

    // Trust badge
    const badge = getTrustBadge(plugin.signature);
    const trustBadge = document.createElement("span");
    trustBadge.className = `inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border ${badge.color}`;
    trustBadge.innerHTML = `<i class="fa-solid ${badge.icon}"></i> ${badge.label}`;
    trustBadge.title = badge.tooltip;
    titleRow.appendChild(trustBadge);

    const runtimeBadge = document.createElement("span");
    const isWasm = plugin.runtime === "wasm";
    const isV2 = Number(plugin.apiVersion || 1) >= 2;
    runtimeBadge.className = `inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border ${
      isServerOnly
        ? "text-fuchsia-200 border-fuchsia-700 bg-fuchsia-950/50"
        : isWasm
        ? "text-cyan-300 border-cyan-700 bg-cyan-950/40"
        : isV2
          ? "text-emerald-300 border-emerald-700 bg-emerald-950/40"
        : "text-slate-300 border-slate-700 bg-slate-900/60"
    }`;
    runtimeBadge.innerHTML = isServerOnly
      ? '<i class="fa-solid fa-server"></i> Server Extension'
      : isWasm
      ? '<i class="fa-solid fa-cube"></i> WASM 2.0'
      : isV2
        ? '<i class="fa-solid fa-code"></i> Plugin 2.0'
      : '<i class="fa-solid fa-puzzle-piece"></i> Native Legacy';
    titleRow.appendChild(runtimeBadge);

    const subtitle = document.createElement("div");
    subtitle.className = "text-sm text-slate-400";
    subtitle.textContent = `${plugin.id}${plugin.version ? ` • v${plugin.version}` : ""}`;

    if (plugin.signature?.fingerprint) {
      const fpSpan = document.createElement("span");
      fpSpan.className = "ml-2 text-xs text-slate-500 font-mono";
      fpSpan.textContent = `${plugin.signature.fingerprint.slice(0, 16)}…`;
      fpSpan.title = `Signer fingerprint: ${plugin.signature.fingerprint}`;
      subtitle.appendChild(fpSpan);
    }

    meta.appendChild(titleRow);
    meta.appendChild(subtitle);
    const needLines = describeNeeds(plugin.needs);
    if (needLines.length) {
      const needsBox = document.createElement("div");
      needsBox.className = "mt-2 text-xs text-slate-300 space-y-1";
      needsBox.innerHTML = `
        <div class="${plugin.needsApproved ? "text-emerald-300" : "text-amber-300"}">
          <i class="fa-solid ${plugin.needsApproved ? "fa-lock-open" : "fa-lock"} mr-1"></i>
          ${plugin.needsApproved ? "Needs approved" : isServerOnly ? "Needs approval before enable" : "Needs approval before load"}
        </div>
        ${needLines.map((line) => `<div class="font-mono text-slate-400">${escapeHtml(line)}</div>`).join("")}
      `;
      meta.appendChild(needsBox);
    }
    if (isServerOnly) {
      const serverBox = document.createElement("div");
      serverBox.className = "mt-2 flex flex-wrap items-center gap-2 text-xs";
      const state = document.createElement("span");
      state.className = `inline-flex items-center gap-1 px-2 py-1 rounded-lg border ${
        plugin.serverRunning
          ? "text-emerald-200 border-emerald-700 bg-emerald-950/40"
          : plugin.enabled
            ? "text-amber-200 border-amber-700 bg-amber-950/40"
            : "text-slate-300 border-slate-700 bg-slate-900/60"
      }`;
      state.innerHTML = plugin.serverRunning
        ? '<i class="fa-solid fa-circle-play"></i> Worker running'
        : plugin.enabled
          ? '<i class="fa-solid fa-triangle-exclamation"></i> Enabled, worker stopped'
          : '<i class="fa-solid fa-circle-stop"></i> Disabled';
      serverBox.appendChild(state);
      if (plugin.build) {
        const buildBadge = document.createElement("span");
        buildBadge.className = "inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-blue-200 border-blue-700 bg-blue-950/40";
        buildBadge.innerHTML = '<i class="fa-solid fa-hammer"></i> Build plugin';
        serverBox.appendChild(buildBadge);
      }
      meta.appendChild(serverBox);
    }
    const actions = document.createElement("div");
    actions.className = "flex items-center gap-2";

    const toggle = document.createElement("button");
    toggle.className =
      "inline-flex items-center gap-2 px-3 py-2 rounded-lg border" +
      (plugin.enabled
        ? " border-emerald-600 text-emerald-200 bg-emerald-900/40"
        : " border-slate-600 text-slate-300 bg-slate-800/60");
    toggle.innerHTML = isServerOnly
      ? plugin.enabled
        ? '<i class="fa-solid fa-power-off"></i> Disable'
        : '<i class="fa-solid fa-server"></i> Enable'
      : plugin.enabled
        ? '<i class="fa-solid fa-toggle-on"></i> Enabled'
        : '<i class="fa-solid fa-toggle-off"></i> Disabled';
    toggle.addEventListener("click", async () => {
      const wantEnabled = !plugin.enabled;
      try {
        const res = await fetch(`/api/plugins/${plugin.id}/enable`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: wantEnabled }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          if (data && data.error === "needs_approval_required") {
            showNeedsApprovalModal(plugin, data.needs, data.needsHash, async () => {
              await setPluginEnabled(plugin, wantEnabled, true);
              await refresh();
            });
            return;
          }
          if (data && data.error === "confirmation_required") {
            showPluginEnableConfirmModal(plugin, data.signature);
            return;
          }
          setStatus(`Enable failed: ${data?.error || res.statusText}`, true);
          return;
        }
        notifyPluginsChanged();
        await refresh();
      } catch (err) {
        setStatus("Enable failed", true);
      }
    });

    let autoLoadBtn = null;
    if (!isServerOnly) {
      autoLoadBtn = document.createElement("button");
      const autoLoadDisabled = !plugin.enabled;
      autoLoadBtn.className =
        "inline-flex items-center gap-2 px-3 py-2 rounded-lg border" +
        (autoLoadDisabled
          ? " border-slate-700 text-slate-500 bg-slate-900/40 cursor-not-allowed opacity-50"
          : plugin.autoLoad
            ? " border-amber-600 text-amber-200 bg-amber-900/40"
            : " border-slate-600 text-slate-300 bg-slate-800/60");
      autoLoadBtn.innerHTML = plugin.autoLoad
        ? '<i class="fa-solid fa-bolt"></i> Auto-load'
        : '<i class="fa-solid fa-bolt-lightning"></i> Auto-load off';
      autoLoadBtn.title = autoLoadDisabled
        ? "Plugin must be enabled before auto-load can be turned on"
        : plugin.autoLoad
          ? "Plugin will auto-load on all new client connections. Click to disable."
          : "Click to auto-load this plugin on all new client connections.";
      if (autoLoadDisabled) {
        autoLoadBtn.disabled = true;
      } else {
        autoLoadBtn.addEventListener("click", async () => {
          const res = await fetch(`/api/plugins/${plugin.id}/autoload`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              autoLoad: !plugin.autoLoad,
              autoStartEvents: plugin.autoStartEvents || [],
            }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => null);
            if (data && data.error === "needs_approval_required") {
              showNeedsApprovalModal(plugin, data.needs, data.needsHash, async () => {
                await fetch(`/api/plugins/${plugin.id}/autoload`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    autoLoad: !plugin.autoLoad,
                    autoStartEvents: plugin.autoStartEvents || [],
                  }),
                });
                await refresh();
              });
              return;
            }
            setStatus(`Auto-load toggle failed: ${data?.error || res.statusText}`, true);
            return;
          }
          notifyPluginsChanged();
          await refresh();
        });
      }
    }

    if (needLines.length && !plugin.needsApproved) {
      const approveBtn = document.createElement("button");
      approveBtn.className =
        "inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-900/40 border border-amber-700/60 hover:bg-amber-800/60 text-amber-100";
      approveBtn.innerHTML = '<i class="fa-solid fa-key"></i> Approve needs';
      approveBtn.addEventListener("click", () => showNeedsApprovalModal(plugin, plugin.needs, plugin.needsHash, refresh));
      actions.appendChild(approveBtn);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className =
      "inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/40 border border-red-700/60 hover:bg-red-800/60 text-red-100";
    removeBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Remove';
    removeBtn.addEventListener("click", async () => {
      if (!confirm(`Remove plugin ${plugin.name || plugin.id}?`)) return;
      const res = await fetch(`/api/plugins/${plugin.id}`, { method: "DELETE" });
      if (!res.ok) {
        const text = await res.text();
        setStatus(`Remove failed: ${text}`, true);
        return;
      }
      setStatus("Plugin removed.");
      notifyPluginsChanged();
      await refresh();
    });
    actions.appendChild(toggle);
    if (autoLoadBtn) actions.appendChild(autoLoadBtn);
    actions.appendChild(removeBtn);
    card.appendChild(meta);
    card.appendChild(actions);

    if (plugin.lastError) {
      const errorRow = document.createElement("div");
      errorRow.className = "mt-2 text-xs text-red-300";
      errorRow.textContent = `Last error: ${plugin.lastError}`;
      card.appendChild(errorRow);
    }
    pluginList.appendChild(card);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function setPluginEnabled(plugin, enabled, confirmed = false) {
  return fetch(`/api/plugins/${plugin.id}/enable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, confirmed }),
  });
}

function showNeedsApprovalModal(plugin, needs, needsHash, afterApprove) {
  document.getElementById("plugin-needs-approval-modal")?.remove();
  const needLines = describeNeeds(needs);
  const overlay = document.createElement("div");
  overlay.id = "plugin-needs-approval-modal";
  overlay.className = "fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm";
  overlay.innerHTML = `
    <div class="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-lg w-full mx-4 shadow-2xl">
      <div class="flex items-center gap-3 mb-4">
        <i class="fa-solid fa-key text-2xl text-amber-300"></i>
        <h3 class="text-lg font-semibold text-slate-100">Approve Plugin Needs</h3>
      </div>
      <p class="text-sm text-slate-300 mb-3"><strong class="text-slate-100">${escapeHtml(plugin.name || plugin.id)}</strong> is asking for filesystem bridges before it can ${plugin.runtime === "server" ? "be enabled" : "be sent to clients"}.</p>
      <div class="rounded-lg border border-slate-700 bg-slate-950/70 p-3 mb-3 space-y-2">
        ${needLines.length ? needLines.map((line) => `<div class="text-xs font-mono text-slate-300">${escapeHtml(line)}</div>`).join("") : '<div class="text-sm text-slate-400">No filesystem needs declared.</div>'}
      </div>
      ${needsHash ? `<p class="text-xs text-slate-500 font-mono mb-4">Needs hash: ${escapeHtml(needsHash.slice(0, 16))}...</p>` : ""}
      <div class="flex justify-end gap-2">
        <button id="plugin-needs-cancel" class="px-4 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-300 hover:bg-slate-700">Cancel</button>
        <button id="plugin-needs-ok" class="px-4 py-2 rounded-lg bg-amber-900/40 border border-amber-700/60 text-amber-100 hover:bg-amber-800/60">Approve</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById("plugin-needs-cancel")?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById("plugin-needs-ok")?.addEventListener("click", async () => {
    const okBtn = document.getElementById("plugin-needs-ok");
    okBtn.disabled = true;
    okBtn.textContent = "Approving...";
    const res = await fetch(`/api/plugins/${plugin.id}/needs/approve`, { method: "POST" });
    if (!res.ok) {
      const text = await res.text();
      setStatus(`Needs approval failed: ${text}`, true);
      overlay.remove();
      return;
    }
    overlay.remove();
    setStatus("Plugin needs approved.");
    notifyPluginsChanged();
    if (typeof afterApprove === "function") await afterApprove();
  });
}

function showPluginEnableConfirmModal(plugin, sigInfo) {
  document.getElementById("plugin-enable-confirm-modal")?.remove();

  const sig = sigInfo || {};
  let statusText = "This plugin is unsigned.";
  let statusColor = "text-orange-400";
  if (sig.signed && sig.valid && !sig.trusted) {
    statusText = "This plugin is signed but the signing key is not trusted.";
    statusColor = "text-yellow-400";
  } else if (sig.signed && !sig.valid) {
    statusText = "This plugin has an invalid signature and may have been tampered with.";
    statusColor = "text-red-400";
  }

  const overlay = document.createElement("div");
  overlay.id = "plugin-enable-confirm-modal";
  overlay.className = "fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm";
  overlay.innerHTML = `
    <div class="bg-slate-900 border border-slate-700 rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl">
      <div class="flex items-center gap-3 mb-4">
        <i class="fa-solid fa-triangle-exclamation text-2xl ${statusColor}"></i>
        <h3 class="text-lg font-semibold text-slate-100">Enable Unverified Plugin</h3>
      </div>
      <p class="text-sm text-slate-300 mb-2">${statusText}</p>
      <p class="text-sm text-slate-400 mb-1">Plugin: <strong class="text-slate-200">${plugin.name || plugin.id}</strong></p>
      ${sig.fingerprint ? `<p class="text-xs text-slate-500 font-mono mb-3">Signer: ${sig.fingerprint}</p>` : '<p class="text-xs text-slate-500 mb-3">No signature present.</p>'}
      <p class="text-sm text-slate-400" style="margin-bottom: 16px;">Type <strong class="text-emerald-300">confirm</strong> below to enable this plugin:</p>
      <input type="text" id="plugin-enable-confirm-input" class="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-100 text-sm focus:outline-none focus:border-emerald-500" style="margin-bottom: 16px;" placeholder="Type confirm" autocomplete="off" spellcheck="false" />
      <div class="flex justify-end gap-2">
        <button id="plugin-enable-confirm-cancel" class="px-4 py-2 rounded-lg bg-slate-800 border border-slate-600 text-slate-300 hover:bg-slate-700">Cancel</button>
        <button id="plugin-enable-confirm-ok" disabled class="px-4 py-2 rounded-lg bg-emerald-900/40 border border-emerald-700/60 text-emerald-100 opacity-50 cursor-not-allowed">Enable Anyway</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = document.getElementById("plugin-enable-confirm-input");
  const okBtn = document.getElementById("plugin-enable-confirm-ok");
  const cancelBtn = document.getElementById("plugin-enable-confirm-cancel");

  input.addEventListener("input", () => {
    const match = input.value.trim().toLowerCase() === "confirm";
    okBtn.disabled = !match;
    okBtn.classList.toggle("opacity-50", !match);
    okBtn.classList.toggle("cursor-not-allowed", !match);
    okBtn.classList.toggle("hover:bg-emerald-800/60", match);
  });

  cancelBtn.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  okBtn.addEventListener("click", async () => {
    okBtn.disabled = true;
    okBtn.textContent = "Enabling...";
    let enabled = false;
    try {
      const res = await fetch(`/api/plugins/${plugin.id}/enable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, confirmed: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.error === "needs_approval_required") {
          overlay.remove();
          showNeedsApprovalModal(plugin, data.needs, data.needsHash, async () => {
            await setPluginEnabled(plugin, true, true);
            await refresh();
          });
          return;
        }
        setStatus(`Enable failed: ${data?.error || res.statusText}`, true);
      } else {
        enabled = true;
      }
    } catch {
      setStatus("Enable failed", true);
    }
    overlay.remove();
    if (enabled) notifyPluginsChanged();
    await refresh();
  });

  input.focus();
}

async function refresh() {
  const plugins = await fetchPlugins();
  renderPlugins(plugins);
}

async function uploadFile(file) {
  if (!file) return;
  setStatus(`Uploading ${file.name}...`);
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/plugins/upload", { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text();
    setStatus(`Upload failed: ${text}`, true);
    return;
  }
  setStatus("Upload complete.");
  notifyPluginsChanged();
  await refresh();
}

if (dropzone) {
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("border-emerald-500", "text-emerald-300");
  });
  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("border-emerald-500", "text-emerald-300");
  });
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("border-emerald-500", "text-emerald-300");
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadFile(file);
  });
}

fileInput?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) uploadFile(file);
});

refreshBtn?.addEventListener("click", refresh);

const trustedKeysSection = document.getElementById("trusted-keys-section");
const trustedKeysList = document.getElementById("trusted-keys-list");
const addKeyBtn = document.getElementById("add-trusted-key-btn");
const newKeyInput = document.getElementById("new-trusted-key-input");

let _builtinKeys = [];

async function fetchTrustedKeys() {
  try {
    const res = await fetch("/api/plugins/trusted-keys");
    if (!res.ok) {
      if (res.status === 403) {
        if (trustedKeysSection) trustedKeysSection.classList.add("hidden");
        return [];
      }
      return [];
    }
    const data = await res.json();
    if (trustedKeysSection) trustedKeysSection.classList.remove("hidden");
    _builtinKeys = Array.isArray(data.builtinKeys) ? data.builtinKeys : [];
    return Array.isArray(data.trustedKeys) ? data.trustedKeys : [];
  } catch {
    return [];
  }
}

function renderTrustedKeys(keys) {
  if (!trustedKeysList) return;
  trustedKeysList.innerHTML = "";
  if (!keys.length) {
    trustedKeysList.innerHTML = '<div class="text-slate-500 text-sm">No trusted keys configured. All plugins will require confirmation to load.</div>';
    return;
  }
  for (const key of keys) {
    const isBuiltin = _builtinKeys.includes(key);
    const row = document.createElement("div");
    row.className = "flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-800 bg-slate-950/50";
    const fp = document.createElement("span");
    fp.className = "font-mono text-sm text-slate-300 flex-1 truncate";
    fp.textContent = key;
    fp.title = key;
    row.appendChild(fp);
    if (isBuiltin) {
      const badge = document.createElement("span");
      badge.className = "text-xs text-emerald-400 px-2 py-0.5 rounded bg-emerald-900/30 whitespace-nowrap";
      badge.textContent = "built-in";
      badge.title = "This key is hardcoded and always trusted";
      row.appendChild(badge);
    } else {
      const removeBtn = document.createElement("button");
      removeBtn.className = "text-red-400 hover:text-red-300 text-sm px-2 py-1";
      removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      removeBtn.title = "Remove trusted key";
      removeBtn.addEventListener("click", async () => {
        const res = await fetch(`/api/plugins/trusted-keys/${key}`, { method: "DELETE" });
        if (res.ok) {
          await refreshTrustedKeys();
          await refresh();
        }
      });
      row.appendChild(removeBtn);
    }
    trustedKeysList.appendChild(row);
  }
}

async function refreshTrustedKeys() {
  const keys = await fetchTrustedKeys();
  renderTrustedKeys(keys);
}

addKeyBtn?.addEventListener("click", async () => {
  const fp = newKeyInput?.value?.trim().toLowerCase();
  if (!fp || !/^[a-f0-9]{64}$/.test(fp)) {
    setStatus("Invalid fingerprint — must be a 64-character hex string (SHA-256)", true);
    return;
  }
  const res = await fetch("/api/plugins/trusted-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprint: fp }),
  });
  if (res.ok) {
    if (newKeyInput) newKeyInput.value = "";
    setStatus("Trusted key added.");
    await refreshTrustedKeys();
    await refresh();
  } else {
    const data = await res.json().catch(() => ({}));
    setStatus(`Failed to add key: ${data.error || "unknown error"}`, true);
  }
});

checkAuth();
refresh();
refreshTrustedKeys();
