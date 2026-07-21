const params = new URLSearchParams(window.location.search);
const targetUserId = Number(params.get("userId") || 0);

const subtitleEl = document.getElementById("target-user-subtitle");
const messageEl = document.getElementById("access-message");

const searchInput = document.getElementById("clients-search");
const refreshBtn = document.getElementById("clients-refresh-btn");
const tableBody = document.getElementById("clients-table-body");
const pageLabel = document.getElementById("clients-page-label");
const prevBtn = document.getElementById("clients-prev-btn");
const nextBtn = document.getElementById("clients-next-btn");

const scopeForm = document.getElementById("scope-form");
const scopeSelect = document.getElementById("scope-select");
const rulesList = document.getElementById("rules-list");

const state = {
  me: null,
  targetUser: null,
  scope: "none",
  rules: [],
  rulesMap: new Map(),
  page: 1,
  pageSize: 30,
  total: 0,
  items: [],
  search: "",
};

function showMessage(text, type = "ok") {
  messageEl.textContent = text;
  messageEl.classList.remove(
    "hidden",
    "text-emerald-200",
    "border-emerald-700",
    "bg-emerald-900/30",
    "text-rose-200",
    "border-rose-700",
    "bg-rose-900/30",
  );

  if (type === "error") {
    messageEl.classList.add("text-rose-200", "border-rose-700", "bg-rose-900/30");
  } else {
    messageEl.classList.add("text-emerald-200", "border-emerald-700", "bg-emerald-900/30");
  }
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function getRule(clientId) {
  return state.rulesMap.get(clientId) || "";
}

function getEffective(clientId) {
  if (state.targetUser?.role === "admin") return true;
  const rule = getRule(clientId);

  if (state.scope === "none") return false;
  if (state.scope === "all") return true;
  if (state.scope === "allowlist") return rule === "allow";
  if (state.scope === "denylist") return rule !== "deny";
  return false;
}

function renderRules() {
  if (!state.rules.length) {
    rulesList.innerHTML = '<div class="text-sm text-slate-500">No explicit rules.</div>';
    return;
  }

  rulesList.innerHTML = state.rules
    .map(
      (rule) => `
      <div class="flex items-center justify-between gap-2 text-sm rounded-lg bg-slate-900 border border-slate-800 px-2 py-1.5">
        <div class="min-w-0 flex-1">
          <span class="block font-mono text-xs sm:text-sm text-slate-200 truncate" title="${escapeHtml(rule.clientId)}">${escapeHtml(rule.clientId)}</span>
          <span class="ml-2 ${rule.access === "allow" ? "text-emerald-300" : "text-rose-300"}">${rule.access}</span>
        </div>
        <button
          type="button"
          class="rule-remove-btn px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
          data-client-id="${escapeHtml(rule.clientId)}"
        >
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    `,
    )
    .join("");
}

function renderClients() {
  if (!state.items.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="6" class="px-3 py-6 text-center text-slate-400">No matching clients</td>
      </tr>
    `;
  } else {
    tableBody.innerHTML = state.items
      .map((client) => {
        const rule = getRule(client.id);
        const effective = getEffective(client.id);
        const status = client.online ? "online" : "offline";

        return `
          <tr>
            <td class="px-3 py-2">
              <div class="font-mono text-xs sm:text-sm text-slate-100">${escapeHtml(client.id)}</div>
              <div class="text-xs text-slate-500">${escapeHtml(client.os || "unknown")} / ${escapeHtml(client.arch || "-")}</div>
            </td>
            <td class="px-3 py-2 text-slate-300">
              <div>${escapeHtml(client.host || "-")}</div>
              <div class="text-xs text-slate-500">${escapeHtml(client.user || "-")}</div>
            </td>
            <td class="px-3 py-2">
              <span class="px-2 py-0.5 rounded-full text-xs ${client.online ? "bg-emerald-900/40 text-emerald-300 border border-emerald-800" : "bg-slate-800 text-slate-400 border border-slate-700"}">${status}</span>
            </td>
            <td class="px-3 py-2 ${rule === "allow" ? "text-emerald-300" : rule === "deny" ? "text-rose-300" : "text-slate-500"}">${rule || "none"}</td>
            <td class="px-3 py-2 ${effective ? "text-emerald-300" : "text-rose-300"}">${effective ? "visible" : "hidden"}</td>
            <td class="px-3 py-2 text-right">
              <div class="inline-flex gap-1">
                <button type="button" class="rule-btn px-2 py-1 text-xs rounded bg-emerald-800/70 hover:bg-emerald-700 text-white disabled:opacity-50" data-client-id="${escapeHtml(client.id)}" data-access="allow" ${rule === "allow" ? "disabled" : ""}>Allow</button>
                <button type="button" class="rule-btn px-2 py-1 text-xs rounded bg-rose-800/70 hover:bg-rose-700 text-white disabled:opacity-50" data-client-id="${escapeHtml(client.id)}" data-access="deny" ${rule === "deny" ? "disabled" : ""}>Deny</button>
                <button type="button" class="rule-clear-btn px-2 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-50" data-client-id="${escapeHtml(client.id)}" ${!rule ? "disabled" : ""}>Clear</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  pageLabel.textContent = `Page ${state.page} / ${totalPages} (${state.total} clients)`;
  prevBtn.disabled = state.page <= 1;
  nextBtn.disabled = state.page >= totalPages;
}

async function loadCurrentUser() {
  const res = await fetch("/api/auth/me", { credentials: "include" });
  if (!res.ok) {
    window.location.href = "/";
    return;
  }
  state.me = await res.json();
  const permissions = Array.isArray(state.me.permissions) ? state.me.permissions : [];
  if (!permissions.includes("users:manage")) {
    window.location.href = "/";
  }
}

async function loadTargetUser() {
  const res = await fetch("/api/users", { credentials: "include" });
  if (!res.ok) {
    throw new Error("Failed to load users");
  }
  const data = await res.json().catch(() => ({ users: [] }));
  state.targetUser = (data.users || []).find((user) => user.id === targetUserId) || null;
  if (!state.targetUser) {
    throw new Error("Target user not found");
  }

  subtitleEl.textContent = `Managing visibility for ${state.targetUser.username} (${state.targetUser.role})`;
}

async function loadPolicy() {
  const res = await fetch(`/api/users/${targetUserId}/client-access`, { credentials: "include" });
  if (!res.ok) {
    throw new Error("Failed to load access policy");
  }

  const data = await res.json().catch(() => ({ scope: "none", rules: [] }));
  state.scope = data.scope || "none";
  state.rules = Array.isArray(data.rules) ? data.rules : [];
  state.rulesMap = new Map(state.rules.map((rule) => [rule.clientId, rule.access]));

  scopeSelect.value = state.scope;
  renderRules();
}

async function loadClients() {
  tableBody.innerHTML = `
    <tr>
      <td colspan="6" class="px-3 py-6 text-center text-slate-400">Loading clients...</td>
    </tr>
  `;

  const query = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
    q: state.search,
    sort: "last_seen_desc",
    status: "all",
    os: "all",
  });

  const res = await fetch(`/api/clients?${query.toString()}`, { credentials: "include" });
  if (!res.ok) {
    throw new Error("Failed to load clients");
  }

  const data = await res.json();
  state.items = Array.isArray(data.items) ? data.items : [];
  state.total = Number(data.total) || 0;
  renderClients();
}

async function saveScope(event) {
  event.preventDefault();

  const nextScope = scopeSelect.value;
  const res = await fetch(`/api/users/${targetUserId}/client-access`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ scope: nextScope }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showMessage(data.error || "Failed to save scope", "error");
    return;
  }

  state.scope = nextScope;
  showMessage("Scope updated.");
  renderClients();
}

async function setRule(clientId, access) {
  const res = await fetch(`/api/users/${targetUserId}/client-access/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ clientId, access }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showMessage(data.error || "Failed to save rule", "error");
    return;
  }

  await loadPolicy();
  renderClients();
  showMessage(`Rule saved: ${access} ${clientId}`);
}

async function clearRule(clientId) {
  const res = await fetch(
    `/api/users/${targetUserId}/client-access/rules?clientId=${encodeURIComponent(clientId)}`,
    {
      method: "DELETE",
      credentials: "include",
    },
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showMessage(data.error || "Failed to remove rule", "error");
    return;
  }

  await loadPolicy();
  renderClients();
  showMessage(`Rule removed for ${clientId}`);
}

tableBody.addEventListener("click", async (event) => {
  const ruleBtn = event.target.closest(".rule-btn");
  if (ruleBtn) {
    const clientId = ruleBtn.dataset.clientId;
    const access = ruleBtn.dataset.access;
    if (clientId && (access === "allow" || access === "deny")) {
      await setRule(clientId, access);
    }
    return;
  }

  const clearBtn = event.target.closest(".rule-clear-btn");
  if (clearBtn) {
    const clientId = clearBtn.dataset.clientId;
    if (clientId) {
      await clearRule(clientId);
    }
  }
});

rulesList.addEventListener("click", async (event) => {
  const removeBtn = event.target.closest(".rule-remove-btn");
  if (!removeBtn) return;
  const clientId = removeBtn.dataset.clientId;
  if (clientId) {
    await clearRule(clientId);
  }
});

scopeForm.addEventListener("submit", saveScope);

searchInput.addEventListener("input", () => {
  state.search = searchInput.value.trim();
  state.page = 1;
  loadClients().catch((error) => {
    console.error(error);
    showMessage("Failed to load clients", "error");
  });
});

refreshBtn.addEventListener("click", () => {
  loadClients().catch((error) => {
    console.error(error);
    showMessage("Failed to refresh clients", "error");
  });
});

prevBtn.addEventListener("click", () => {
  if (state.page <= 1) return;
  state.page -= 1;
  loadClients().catch((error) => {
    console.error(error);
    showMessage("Failed to load previous page", "error");
  });
});

nextBtn.addEventListener("click", () => {
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  if (state.page >= totalPages) return;
  state.page += 1;
  loadClients().catch((error) => {
    console.error(error);
    showMessage("Failed to load next page", "error");
  });
});

async function init() {
  if (!targetUserId || Number.isNaN(targetUserId)) {
    window.location.href = "/users";
    return;
  }

  try {
    await loadCurrentUser();
    await loadTargetUser();
    await loadPolicy();
    await loadClients();
  } catch (error) {
    console.error(error);
    showMessage("Failed to initialize access manager", "error");
  }
}

init();
