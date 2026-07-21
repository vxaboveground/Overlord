let currentUser = null;
let users = [];
let onlyOwnUsers = localStorage.getItem("adminOnlyOwnUsers") === "1";

import { escapeHtml, formatDate } from "./format.js";

const usersTableBody = document.getElementById("users-table-body");
const addUserBtn = document.getElementById("add-user-btn");
const ownUsersToggle = document.getElementById("own-users-toggle");
const userModal = document.getElementById("user-modal");
const modalTitle = document.getElementById("modal-title");
const userForm = document.getElementById("user-form");
const closeModal = document.getElementById("close-modal");
const cancelBtn = document.getElementById("cancel-btn");
const errorMessage = document.getElementById("error-message");
const errorText = document.getElementById("error-text");
const generatePasswordBtn = document.getElementById("generate-password-btn");
const generatedPasswordHint = document.getElementById("generated-password-hint");
const mustChangePasswordInput = document.getElementById("must-change-password");
const logoutBtn = document.getElementById("logout-btn");
const currentUserEl = document.getElementById("username-display");
const currentRoleEl = document.getElementById("role-badge");

function hasPermission(permission) {
  return Array.isArray(currentUser?.permissions) && currentUser.permissions.includes(permission);
}

async function getCurrentUser() {
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      currentUser = await res.json();
      currentUserEl.textContent = currentUser.username;

      const roleBadges = {
        admin: '<i class="fa-solid fa-crown mr-1"></i>Admin',
        operator: '<i class="fa-solid fa-sliders mr-1"></i>Operator',
        viewer: '<i class="fa-solid fa-eye mr-1"></i>Viewer',
      };
      if (roleBadges[currentUser.role]) {
        currentRoleEl.innerHTML = roleBadges[currentUser.role];
      } else {
        currentRoleEl.textContent = currentUser.role || "";
      }

      if (currentUser.role === "admin") {
        currentRoleEl.classList.add(
          "bg-purple-900/50",
          "text-purple-300",
          "border",
          "border-purple-800",
        );
      } else if (currentUser.role === "operator") {
        currentRoleEl.classList.add(
          "bg-blue-900/50",
          "text-blue-300",
          "border",
          "border-blue-800",
        );
      } else {
        currentRoleEl.classList.add(
          "bg-slate-700",
          "text-slate-300",
          "border",
          "border-slate-600",
        );
      }

      if (hasPermission("audit:view")) {
        document.getElementById("metrics-link")?.classList.remove("hidden");
      }
      if (hasPermission("scripts:manage")) {
        document.getElementById("scripts-link")?.classList.remove("hidden");
      }
      if (hasPermission("clients:build") || currentUser.canBuild) {
        document.getElementById("build-link")?.classList.remove("hidden");
      }
      if (hasPermission("users:manage")) {
        document.getElementById("users-link")?.classList.remove("hidden");
      }
      if (hasPermission("plugins:manage")) {
        document.getElementById("plugins-link")?.classList.remove("hidden");
      }
      if (hasPermission("deploys:manage")) {
        document.getElementById("deploy-link")?.classList.remove("hidden");
      }

      if (!hasPermission("users:manage")) {
        alert("Access denied. Missing users:manage permission.");
        window.location.href = "/";
      }

      renderUsers();
    } else {
      window.location.href = "/";
    }
  } catch (err) {
    console.error("Failed to get current user:", err);
    window.location.href = "/";
  }
}

if (logoutBtn && !logoutBtn.dataset.boundLogout) {
  logoutBtn.dataset.boundLogout = "true";
  logoutBtn.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to logout?")) return;

    try {
      const res = await fetch("/api/logout", { method: "POST" });
      if (res.ok) {
        window.location.href = "/";
      } else {
        alert("Logout failed. Please try again.");
      }
    } catch (err) {
      console.error("Logout error:", err);
      alert("Logout failed. Please try again.");
    }
  });
}

async function loadUsers() {
  try {
    const res = await fetch("/api/users");
    if (!res.ok) {
      throw new Error("Failed to load users");
    }

    const data = await res.json();
    users = data.users || [];
    renderUsers();
  } catch (err) {
    console.error("Load users error:", err);
    usersTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="px-6 py-12 text-center text-red-400">
          <i class="fa-solid fa-exclamation-triangle mr-2"></i>
          Failed to load users
        </td>
      </tr>
    `;
  }
}

function renderUsers() {
  const visibleUsers = getVisibleUsers();

  if (visibleUsers.length === 0) {
    const emptyMessage = onlyOwnUsers && users.length > 0
      ? "No users created by you"
      : "No users found";
    usersTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="px-6 py-12 text-center text-slate-400">
          <i class="fa-solid fa-users mr-2"></i>
          ${emptyMessage}
        </td>
      </tr>
    `;
    return;
  }

  usersTableBody.innerHTML = visibleUsers
    .map(
      (user) => `
    <tr class="hover:bg-slate-800/30 transition-colors">
      <td class="px-6 py-4">
        <div class="flex items-center gap-2">
          <i class="fa-solid fa-user text-slate-400"></i>
          <span class="font-medium text-slate-200">${escapeHtml(user.username)}</span>
          ${user.id === currentUser?.userId ? '<span class="text-xs text-blue-400">(You)</span>' : ""}
        </div>
      </td>
      <td class="px-6 py-4">
        ${getRoleBadge(user.role)}
        ${user.role !== "admin" ? `
          <span class="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer transition-colors ${user.can_build ? 'bg-green-900/30 text-green-300 border border-green-800 hover:bg-green-900/50' : 'bg-slate-700/30 text-slate-500 border border-slate-700 hover:bg-slate-700/50'}" 
            data-action="toggle-build" data-user-id="${user.id}" data-username="${escapeHtml(user.username)}" data-can-build="${user.can_build ? 1 : 0}"
            title="${user.can_build ? 'Can build (click to revoke)' : 'Cannot build (click to grant)'}">
            <i class="fa-solid fa-hammer mr-1"></i>${user.can_build ? 'Build' : 'No Build'}
          </span>
          <span class="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer transition-colors ${user.can_upload_files ? 'bg-teal-900/30 text-teal-300 border border-teal-800 hover:bg-teal-900/50' : 'bg-slate-700/30 text-slate-500 border border-slate-700 hover:bg-slate-700/50'}" 
            data-action="toggle-upload" data-user-id="${user.id}" data-username="${escapeHtml(user.username)}" data-can-upload="${user.can_upload_files ? 1 : 0}"
            title="${user.can_upload_files ? 'Can upload files (click to revoke)' : 'Cannot upload files (click to grant)'}">
            <i class="fa-solid fa-cloud-arrow-up mr-1"></i>${user.can_upload_files ? 'Upload' : 'No Upload'}
          </span>
        ` : ''}
      </td>
      <td class="px-6 py-4 text-sm text-slate-400">
        ${formatDate(user.created_at)}
      </td>
      <td class="px-6 py-4 text-sm text-slate-400">
        ${user.last_login ? formatDate(user.last_login) : '<span class="text-slate-500">Never</span>'}
      </td>
      <td class="px-6 py-4 text-sm text-slate-400">
        ${escapeHtml(user.created_by || "System")}
      </td>
      <td class="px-6 py-4">
        <div class="flex items-center justify-end gap-2">
          ${
            user.id !== currentUser?.userId
              ? `
            <button 
              class="user-action-btn px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 transition-colors"
              data-action="change-password"
              data-user-id="${user.id}"
              data-username="${escapeHtml(user.username)}"
              title="Change Password"
            >
              <i class="fa-solid fa-key"></i>
            </button>
            <button 
              class="user-action-btn px-3 py-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 transition-colors"
              data-action="change-role"
              data-user-id="${user.id}"
              data-username="${escapeHtml(user.username)}"
              data-role="${escapeHtml(user.role)}"
              title="Change Role"
            >
              <i class="fa-solid fa-user-tag"></i>
            </button>
            <button 
              class="user-action-btn px-3 py-1.5 text-sm bg-indigo-900/30 hover:bg-indigo-900/50 text-indigo-300 rounded border border-indigo-800 transition-colors"
              data-action="client-access"
              data-user-id="${user.id}"
              data-username="${escapeHtml(user.username)}"
              data-role="${escapeHtml(user.role)}"
              title="Client Visibility"
            >
              <i class="fa-solid fa-user-shield"></i>
            </button>
            ${user.role !== "admin" ? `
            <button
              class="user-action-btn px-3 py-1.5 text-sm bg-emerald-900/30 hover:bg-emerald-900/50 text-emerald-300 rounded border border-emerald-800 transition-colors"
              data-action="plugin-access"
              data-user-id="${user.id}"
              data-username="${escapeHtml(user.username)}"
              title="Plugin Access"
            >
              <i class="fa-solid fa-puzzle-piece"></i>
            </button>
            ` : ''}
            ${user.role !== "admin" ? `
            <button
              class="user-action-btn px-3 py-1.5 text-sm bg-violet-900/30 hover:bg-violet-900/50 text-violet-300 rounded border border-violet-800 transition-colors"
              data-action="permissions"
              data-user-id="${user.id}"
              data-username="${escapeHtml(user.username)}"
              data-role="${escapeHtml(user.role)}"
              title="Permissions & Feature Access"
            >
              <i class="fa-solid fa-layer-group"></i>
            </button>
            ` : ''}
            <button
              class="user-action-btn px-3 py-1.5 text-sm bg-cyan-900/30 hover:bg-cyan-900/50 text-cyan-300 rounded border border-cyan-800 transition-colors"
              data-action="view-sessions"
              data-user-id="${user.id}"
              data-username="${escapeHtml(user.username)}"
              title="View Sessions"
            >
              <i class="fa-solid fa-desktop"></i>
            </button>
            <button 
              class="user-action-btn px-3 py-1.5 text-sm bg-red-900/20 hover:bg-red-900/40 text-red-400 rounded border border-red-800 transition-colors"
              data-action="delete"
              data-user-id="${user.id}"
              data-username="${escapeHtml(user.username)}"
              title="Delete User"
            >
              <i class="fa-solid fa-trash"></i>
            </button>
          `
              : '<span class="text-slate-500 text-sm italic">Cannot edit yourself</span>'
          }
        </div>
      </td>
    </tr>
  `,
    )
    .join("");

  attachActionListeners();
}

function getVisibleUsers() {
  if (!onlyOwnUsers || !currentUser) return users;
  return users.filter((user) => (
    user.id === currentUser.userId ||
    user.username === currentUser.username ||
    user.created_by === currentUser.username
  ));
}

function getRoleBadge(role) {
  const badges = {
    admin:
      '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-900/30 text-purple-300 border border-purple-800"><i class="fa-solid fa-crown mr-1"></i>Admin</span>',
    operator:
      '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-900/30 text-blue-300 border border-blue-800"><i class="fa-solid fa-sliders mr-1"></i>Operator</span>',
    viewer:
      '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-700/50 text-slate-300 border border-slate-600"><i class="fa-solid fa-eye mr-1"></i>Viewer</span>',
  };
  return badges[role] || escapeHtml(role || "");
}

function attachActionListeners() {
  const oldListener = usersTableBody._actionListener;
  if (oldListener) {
    usersTableBody.removeEventListener("click", oldListener);
  }

  const listener = (e) => {
    const toggleBuild = e.target.closest("[data-action='toggle-build']");
    if (toggleBuild) {
      const userId = parseInt(toggleBuild.dataset.userId);
      const username = toggleBuild.dataset.username;
      const canBuild = toggleBuild.dataset.canBuild === "1";
      toggleBuildPermission(userId, username, canBuild);
      return;
    }

    const toggleUpload = e.target.closest("[data-action='toggle-upload']");
    if (toggleUpload) {
      const userId = parseInt(toggleUpload.dataset.userId);
      const username = toggleUpload.dataset.username;
      const canUpload = toggleUpload.dataset.canUpload === "1";
      toggleUploadPermission(userId, username, canUpload);
      return;
    }

    const btn = e.target.closest(".user-action-btn");
    if (!btn) return;

    const action = btn.dataset.action;
    const userId = parseInt(btn.dataset.userId);
    const username = btn.dataset.username;
    const role = btn.dataset.role;

    switch (action) {
      case "change-password":
        changePassword(userId, username);
        break;
      case "change-role":
        changeRole(userId, username, role);
        break;
      case "delete":
        deleteUser(userId, username);
        break;
      case "client-access":
        configureClientAccess(userId, username, role);
        break;
      case "plugin-access":
        configurePluginAccess(userId, username);
        break;
      case "view-sessions":
        viewUserSessions(userId, username);
        break;
      case "permissions":
        openUserPermissionsModal(userId, username);
        break;
    }
  };

  usersTableBody.addEventListener("click", listener);
  usersTableBody._actionListener = listener;
}

function showModal(title) {
  modalTitle.textContent = title;
  userModal.classList.remove("hidden");
  errorMessage.classList.add("hidden");
  userForm.reset();
}

function hideModal() {
  userModal.classList.add("hidden");
  userForm.reset();
  generatedPasswordHint?.classList.add("hidden");
  const passwordInput = document.getElementById("password");
  if (passwordInput) passwordInput.type = "password";
}

function showError(message) {
  errorText.textContent = message;
  errorMessage.classList.remove("hidden");
}

function generatePassword(length = 20) {
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%^&*()-_=+[]{}";
  const required = [lower, upper, digits, symbols];
  const alphabet = required.join("");
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  const chars = required.map((set, index) => set[bytes[index] % set.length]);
  for (let i = required.length; i < length; i++) {
    chars.push(alphabet[bytes[i] % alphabet.length]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

generatePasswordBtn?.addEventListener("click", () => {
  const passwordInput = document.getElementById("password");
  if (!passwordInput) return;
  passwordInput.value = generatePassword();
  passwordInput.type = "text";
  generatedPasswordHint?.classList.remove("hidden");
  passwordInput.focus();
  passwordInput.select();
});

addUserBtn.addEventListener("click", () => {
  showModal("Add User");
  document.getElementById("password-field").classList.remove("hidden");
  document.getElementById("password").required = true;
  generatedPasswordHint?.classList.add("hidden");
});

closeModal.addEventListener("click", hideModal);
cancelBtn.addEventListener("click", hideModal);

if (ownUsersToggle) {
  ownUsersToggle.checked = onlyOwnUsers;
  ownUsersToggle.addEventListener("change", () => {
    onlyOwnUsers = ownUsersToggle.checked;
    localStorage.setItem("adminOnlyOwnUsers", onlyOwnUsers ? "1" : "0");
    renderUsers();
  });
}

userForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const formData = new FormData(userForm);
  const username = formData.get("username");
  const password = formData.get("password");
  const role = formData.get("role");
  const mustChangePassword = mustChangePasswordInput?.checked !== false;

  try {
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, role, mustChangePassword }),
    });

    const data = await res.json();

    if (res.ok) {
      hideModal();
      await loadUsers();
    } else {
      showError(data.error || "Failed to create user");
    }
  } catch (err) {
    console.error("Create user error:", err);
    showError("Network error. Please try again.");
  }
});

window.changePassword = async function (userId, username) {
  const password = prompt(`Enter new password for ${username}:`);
  if (!password) return;

  if (password.length < 6) {
    alert("Password must be at least 6 characters");
    return;
  }

  try {
    const res = await fetch(`/api/users/${userId}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    const data = await res.json();

    if (res.ok) {
      alert("Password updated successfully");
    } else {
      alert(data.error || "Failed to update password");
    }
  } catch (err) {
    console.error("Update password error:", err);
    alert("Network error. Please try again.");
  }
};

window.changeRole = async function (userId, username, currentRole) {
  const roles = ["viewer", "operator", "admin"];
  const roleNames = { viewer: "Viewer", operator: "Operator", admin: "Admin" };

  const message = `Select new role for ${username}:\n\n1. Viewer (Read-only)\n2. Operator (Control clients)\n3. Admin (Full access)\n\nCurrent: ${roleNames[currentRole]}`;
  const choice = prompt(message);

  if (!choice || !["1", "2", "3"].includes(choice)) return;

  const newRole = roles[parseInt(choice) - 1];

  if (newRole === currentRole) {
    alert("No change made");
    return;
  }

  if (!confirm(`Change ${username}'s role to ${roleNames[newRole]}?`)) return;

  try {
    const res = await fetch(`/api/users/${userId}/role`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });

    const data = await res.json();

    if (res.ok) {
      alert("Role updated successfully");
      await loadUsers();
    } else {
      alert(data.error || "Failed to update role");
    }
  } catch (err) {
    console.error("Update role error:", err);
    alert("Network error. Please try again.");
  }
};

window.deleteUser = async function (userId, username) {
  if (
    !confirm(
      `Are you sure you want to delete user "${username}"? This action cannot be undone.`,
    )
  ) {
    return;
  }

  try {
    const res = await fetch(`/api/users/${userId}`, {
      method: "DELETE",
    });

    const data = await res.json();

    if (res.ok) {
      alert("User deleted successfully");
      await loadUsers();
    } else {
      alert(data.error || "Failed to delete user");
    }
  } catch (err) {
    console.error("Delete user error:", err);
    alert("Network error. Please try again.");
  }
};

window.configureClientAccess = async function (userId, username, role) {
  const params = new URLSearchParams({ userId: String(userId) });
  window.location.href = `/user-client-access?${params.toString()}`;
};

const FEATURE_LABELS = {
  console: { label: "Console", icon: "fa-terminal" },
  remote_desktop: { label: "Remote Desktop", icon: "fa-desktop" },
  backstage: { label: "backstage", icon: "fa-window-restore" },
  webcam: { label: "Webcam", icon: "fa-video" },
  file_browser: { label: "File Browser", icon: "fa-folder-open" },
  processes: { label: "Processes", icon: "fa-microchip" },
  keylogger: { label: "Keylogger", icon: "fa-keyboard" },
  voice: { label: "Voice", icon: "fa-microphone" },
  disconnect: { label: "Disconnect Client", icon: "fa-plug-circle-xmark" },
  reconnect: { label: "Reconnect Client", icon: "fa-arrows-rotate" },
  uninstall: { label: "Uninstall Agent", icon: "fa-trash-can" },
  client_metadata: { label: "Edit Client Metadata", icon: "fa-pen-to-square" },
};


window.configurePluginAccess = async function (userId, username) {
  try {
    const [accessRes, pluginsRes] = await Promise.all([
      fetch(`/api/users/${userId}/plugin-access`),
      fetch("/api/plugins"),
    ]);
    if (!accessRes.ok) throw new Error("Failed to load plugin access");

    const accessData = await accessRes.json();
    const currentScope = accessData.scope || "none";
    const allowedIds = new Set((accessData.rules || []).map(r => r.pluginId));

    let allPlugins = [];
    if (pluginsRes.ok) {
      const pluginsData = await pluginsRes.json();
      allPlugins = pluginsData.plugins || [];
    }

    let modal = document.getElementById("plugin-access-modal");
    if (modal) modal.remove();

    modal = document.createElement("div");
    modal.id = "plugin-access-modal";
    modal.className = "fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4";

    const scopeOptions = [
      { value: "none", label: "No Access", desc: "User cannot access any plugins" },
      { value: "allowlist", label: "Selected Plugins", desc: "User can only access checked plugins" },
      { value: "all", label: "All Plugins", desc: "User can access all plugins" },
    ];

    modal.innerHTML = `
      <div class="bg-slate-900 border border-slate-700 rounded-xl max-w-md w-full p-6 shadow-2xl max-h-[85vh] flex flex-col">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-xl font-bold text-slate-100">Plugin Access</h3>
          <button id="close-plugin-modal" class="text-slate-400 hover:text-slate-200 transition-colors">
            <i class="fa-solid fa-times text-xl"></i>
          </button>
        </div>
        <p class="text-sm text-slate-400 mb-4">
          Manage plugin access for <span class="text-slate-200 font-medium">${escapeHtml(username)}</span>.
        </p>
        <div class="mb-4">
          <label class="block text-sm font-medium text-slate-300 mb-2">Access Mode</label>
          <select id="plugin-scope-select" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500">
            ${scopeOptions.map(o => `<option value="${o.value}" ${o.value === currentScope ? "selected" : ""}>${o.label}</option>`).join("")}
          </select>
          <p id="plugin-scope-desc" class="text-xs text-slate-500 mt-1">${scopeOptions.find(o => o.value === currentScope)?.desc || ""}</p>
        </div>
        <div id="plugin-list-section" class="${currentScope !== "allowlist" ? "hidden" : ""} flex-1 overflow-y-auto mb-4">
          <label class="block text-sm font-medium text-slate-300 mb-2">Select Plugins</label>
          <div class="space-y-2" id="plugin-toggles">
            ${allPlugins.length === 0
              ? '<p class="text-sm text-slate-500 italic">No plugins installed</p>'
              : allPlugins.map(p => `
                <label class="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700 hover:border-slate-600 cursor-pointer transition-colors">
                  <div class="flex items-center gap-3">
                    <i class="fa-solid fa-puzzle-piece text-slate-400 w-5 text-center"></i>
                    <span class="text-slate-200 font-medium">${escapeHtml(p.name || p.id)}</span>
                    <span class="text-xs text-slate-500">${escapeHtml(p.id)}</span>
                  </div>
                  <input type="checkbox" data-plugin-id="${escapeHtml(p.id)}" ${allowedIds.has(p.id) ? "checked" : ""}
                    class="w-5 h-5 rounded bg-slate-700 border-slate-600 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-0 cursor-pointer" />
                </label>`).join("")}
          </div>
        </div>
        <div class="flex gap-3">
          <button id="cancel-plugin-access" class="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition-colors font-medium">
            Cancel
          </button>
          <button id="save-plugin-access" class="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors font-medium">
            <i class="fa-solid fa-check mr-2"></i>Save
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const scopeSelect = document.getElementById("plugin-scope-select");
    const scopeDesc = document.getElementById("plugin-scope-desc");
    const listSection = document.getElementById("plugin-list-section");

    scopeSelect.addEventListener("change", () => {
      const val = scopeSelect.value;
      const opt = scopeOptions.find(o => o.value === val);
      scopeDesc.textContent = opt?.desc || "";
      if (val === "allowlist") {
        listSection.classList.remove("hidden");
      } else {
        listSection.classList.add("hidden");
      }
    });

    document.getElementById("close-plugin-modal").addEventListener("click", () => modal.remove());
    document.getElementById("cancel-plugin-access").addEventListener("click", () => modal.remove());
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

    document.getElementById("save-plugin-access").addEventListener("click", async () => {
      const scope = scopeSelect.value;
      const pluginIds = [];
      if (scope === "allowlist") {
        modal.querySelectorAll("[data-plugin-id]").forEach(cb => {
          if (cb.checked) pluginIds.push(cb.dataset.pluginId);
        });
      }

      try {
        const saveRes = await fetch(`/api/users/${userId}/plugin-access`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, pluginIds }),
        });
        if (!saveRes.ok) {
          const err = await saveRes.json().catch(() => ({}));
          throw new Error(err.error || "Failed to save");
        }
        modal.remove();
        if (window.showToast) window.showToast("Plugin access updated", "success");
      } catch (err) {
        alert("Failed to save plugin access: " + err.message);
      }
    });
  } catch (err) {
    console.error("Plugin access error:", err);
    alert("Failed to load plugin access settings");
  }
};

window.toggleBuildPermission = async function (userId, username, currentCanBuild) {
  const newVal = !currentCanBuild;
  if (!confirm(`${newVal ? 'Grant' : 'Revoke'} build permission for ${username}?`)) return;

  try {
    const res = await fetch(`/api/users/${userId}/can-build`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ canBuild: newVal }),
    });

    const data = await res.json();

    if (res.ok) {
      await loadUsers();
    } else {
      alert(data.error || "Failed to update build permission");
    }
  } catch (err) {
    console.error("Toggle build permission error:", err);
    alert("Network error. Please try again.");
  }
};

window.toggleUploadPermission = async function (userId, username, currentCanUpload) {
  const newVal = !currentCanUpload;
  if (!confirm(`${newVal ? 'Grant' : 'Revoke'} file upload permission for ${username}?`)) return;

  try {
    const res = await fetch(`/api/users/${userId}/can-upload-files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ canUploadFiles: newVal }),
    });

    const data = await res.json();

    if (res.ok) {
      await loadUsers();
    } else {
      alert(data.error || "Failed to update upload permission");
    }
  } catch (err) {
    console.error("Toggle upload permission error:", err);
    alert("Network error. Please try again.");
  }
};

async function viewUserSessions(userId, username) {
  try {
    const res = await fetch(`/api/users/${userId}/sessions`);
    if (!res.ok) throw new Error("Failed to fetch sessions");
    const data = await res.json();
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];

    const existing = document.getElementById("sessions-modal");
    if (existing) existing.remove();

    const modal = document.createElement("div");
    modal.id = "sessions-modal";
    modal.className = "fixed inset-0 z-50 flex items-center justify-center bg-black/60";

    const now = Math.floor(Date.now() / 1000);

    const rows = sessions.length === 0
      ? `<tr><td colspan="5" class="px-3 py-6 text-center text-slate-400">No sessions</td></tr>`
      : sessions.map(s => {
          const isExpired = s.expiresAt && s.expiresAt < now;
          const status = s.revoked
            ? '<span class="text-rose-400">Revoked</span>'
            : isExpired
              ? '<span class="text-slate-500">Expired</span>'
              : '<span class="text-emerald-400">Active</span>';
          const canRevoke = !s.revoked && !isExpired;
          const lastAct = s.lastActivity ? formatRelTime(s.lastActivity) : "—";

          return `<tr>
            <td class="px-3 py-2 font-mono text-xs text-slate-100">${escapeHtml(s.ip || "—")}</td>
            <td class="px-3 py-2 text-slate-400 text-xs">${lastAct}</td>
            <td class="px-3 py-2 text-xs">${status}</td>
            <td class="px-3 py-2 text-right">
              ${canRevoke ? `<button class="admin-revoke-session-btn px-2 py-1 rounded bg-red-700/80 hover:bg-red-600 text-white text-xs" data-session-id="${escapeHtml(s.id)}"><i class="fa-solid fa-ban mr-1"></i>Revoke</button>` : ""}
            </td>
          </tr>`;
        }).join("");

    modal.innerHTML = `
      <div class="bg-slate-900 border border-slate-700 rounded-xl p-5 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-slate-100">Sessions — ${escapeHtml(username)}</h3>
          <div class="flex items-center gap-2">
            ${sessions.some(s => !s.revoked) ? `<button id="revoke-all-sessions-btn" class="px-3 py-1.5 text-xs bg-red-700/80 hover:bg-red-600 text-white rounded border border-red-600"><i class="fa-solid fa-ban mr-1"></i>Revoke All</button>` : ""}
            <button id="close-sessions-modal" class="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded">Close</button>
          </div>
        </div>
        <div class="overflow-x-auto border border-slate-800 rounded-lg">
          <table class="w-full text-sm">
            <thead class="bg-slate-800/60 text-slate-300">
              <tr>
                <th class="text-left px-3 py-2">IP</th>
                <th class="text-left px-3 py-2">Last Active</th>
                <th class="text-left px-3 py-2">Status</th>
                <th class="text-right px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-800">${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener("click", (e) => {
      if (e.target === modal || e.target.closest("#close-sessions-modal")) {
        modal.remove();
      }
    });

    modal.querySelectorAll(".admin-revoke-session-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(btn.dataset.sessionId)}`, {
            method: "DELETE",
          });
          if (!r.ok) throw new Error("Failed");
          modal.remove();
          viewUserSessions(userId, username);
        } catch {
          alert("Failed to revoke session");
          btn.disabled = false;
        }
      });
    });

    const revokeAllBtn = document.getElementById("revoke-all-sessions-btn");
    if (revokeAllBtn) {
      revokeAllBtn.addEventListener("click", async () => {
        if (!confirm(`Revoke all sessions for ${username}? They will be logged out immediately.`)) return;
        revokeAllBtn.disabled = true;
        try {
          const r = await fetch(`/api/users/${userId}/sessions`, { method: "DELETE" });
          if (!r.ok) throw new Error("Failed");
          modal.remove();
          viewUserSessions(userId, username);
        } catch {
          alert("Failed to revoke sessions");
          revokeAllBtn.disabled = false;
        }
      });
    }
  } catch (err) {
    console.error("View sessions error:", err);
    alert("Failed to load sessions");
  }
}

function formatRelTime(epochSeconds) {
  if (!epochSeconds) return "—";
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

let allPermissions = [];
let allGroups = [];
let editingGroupId = null;
let editingUserId = null;

async function loadPermissionsAndGroups() {
  try {
    const [permsRes, groupsRes] = await Promise.all([
      fetch("/api/permissions"),
      fetch("/api/permission-groups"),
    ]);
    if (permsRes.ok) {
      const data = await permsRes.json();
      allPermissions = Array.isArray(data.permissions) ? data.permissions : [];
    }
    if (groupsRes.ok) {
      const data = await groupsRes.json();
      allGroups = Array.isArray(data.groups) ? data.groups : [];
    }
    renderGroupsList();
  } catch (err) {
    console.error("Failed to load permissions/groups:", err);
  }
}

function renderGroupsList() {
  const container = document.getElementById("groups-list");
  if (!container) return;
  if (allGroups.length === 0) {
    container.innerHTML = `<p class="text-slate-500 text-sm text-center py-4">No groups yet. Click "New Group" to create one.</p>`;
    return;
  }
  container.innerHTML = allGroups
    .map(
      (g) => `
    <div class="flex items-start justify-between gap-3 p-3 bg-slate-800/40 border border-slate-700 rounded-lg">
      <div class="flex-1 min-w-0">
        <div class="font-medium text-slate-100">${escapeHtml(g.name)}</div>
        ${g.description ? `<div class="text-xs text-slate-400 mt-0.5">${escapeHtml(g.description)}</div>` : ""}
        <div class="text-xs text-slate-500 mt-1">
          ${g.permissions.length} permission${g.permissions.length === 1 ? "" : "s"}:
          <span class="text-slate-400">${g.permissions.map((p) => escapeHtml(p)).join(", ") || "<em>none</em>"}</span>
        </div>
      </div>
      <div class="flex gap-1 flex-shrink-0">
        <button class="group-action px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 rounded" data-action="edit" data-group-id="${g.id}"><i class="fa-solid fa-pen"></i></button>
        <button class="group-action px-2 py-1 text-xs bg-red-900/40 hover:bg-red-900/60 text-red-300 rounded" data-action="delete" data-group-id="${g.id}" data-group-name="${escapeHtml(g.name)}"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>`,
    )
    .join("");
}

document.getElementById("groups-list")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".group-action");
  if (!btn) return;
  const groupId = Number(btn.dataset.groupId);
  if (btn.dataset.action === "edit") openGroupModal(groupId);
  else if (btn.dataset.action === "delete") deleteGroup(groupId, btn.dataset.groupName);
});

document.getElementById("new-group-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  openGroupModal(null);
});

function openGroupModal(groupId) {
  editingGroupId = groupId;
  const modal = document.getElementById("group-modal");
  const title = document.getElementById("group-modal-title");
  const nameInput = document.getElementById("group-name");
  const descInput = document.getElementById("group-description");
  const permsList = document.getElementById("group-permissions-list");
  const errorBox = document.getElementById("group-error");
  errorBox.classList.add("hidden");

  let selected = new Set();
  if (groupId) {
    const g = allGroups.find((x) => x.id === groupId);
    if (g) {
      title.textContent = `Edit Group: ${g.name}`;
      nameInput.value = g.name;
      descInput.value = g.description || "";
      selected = new Set(g.permissions);
    }
  } else {
    title.textContent = "New Group";
    nameInput.value = "";
    descInput.value = "";
  }

  permsList.innerHTML = allPermissions
    .map(
      (p) => `
    <label class="flex items-start gap-2 py-1 cursor-pointer hover:bg-slate-800/40 rounded px-2">
      <input type="checkbox" class="mt-1 h-4 w-4 accent-violet-500" data-perm="${escapeHtml(p.id)}" ${selected.has(p.id) ? "checked" : ""} />
      <div>
        <div class="text-sm font-mono text-slate-200">${escapeHtml(p.id)}</div>
        <div class="text-xs text-slate-500">${escapeHtml(p.description)}</div>
      </div>
    </label>`,
    )
    .join("");

  modal.classList.remove("hidden");
}

function closeGroupModal() {
  document.getElementById("group-modal")?.classList.add("hidden");
  editingGroupId = null;
}
document.getElementById("close-group-modal")?.addEventListener("click", closeGroupModal);
document.getElementById("group-cancel-btn")?.addEventListener("click", closeGroupModal);

document.getElementById("group-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("group-name").value.trim();
  const description = document.getElementById("group-description").value.trim();
  const permissions = Array.from(
    document.querySelectorAll("#group-permissions-list input[type=checkbox]:checked"),
  ).map((el) => el.dataset.perm);
  const errorBox = document.getElementById("group-error");
  errorBox.classList.add("hidden");

  try {
    const url = editingGroupId
      ? `/api/permission-groups/${editingGroupId}`
      : "/api/permission-groups";
    const method = editingGroupId ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, permissions }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errorBox.textContent = data.error || "Failed to save group";
      errorBox.classList.remove("hidden");
      return;
    }
    closeGroupModal();
    await loadPermissionsAndGroups();
  } catch (err) {
    console.error(err);
    errorBox.textContent = "Network error";
    errorBox.classList.remove("hidden");
  }
});

async function deleteGroup(groupId, groupName) {
  if (!confirm(`Delete group "${groupName}"? Users assigned to this group will lose its permissions.`)) return;
  try {
    const res = await fetch(`/api/permission-groups/${groupId}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to delete group");
      return;
    }
    await loadPermissionsAndGroups();
  } catch {
    alert("Network error");
  }
}

function renderEffectivePermissions(container, effective) {
  const permissions = Array.isArray(effective?.permissions) ? effective.permissions : [];
  const granted = permissions.filter((p) => p.allowed);
  const denied = permissions.filter((p) => !p.allowed);
  const ordered = [...granted, ...denied];
  const clientScope = effective?.clientAccess?.scope || "unknown";
  const pluginScope = effective?.pluginAccess?.scope || "unknown";
  const features = effective?.featurePermissions || {};
  const disabledFeatures = Object.entries(features)
    .filter(([, allowed]) => allowed === false)
    .map(([feature]) => feature);

  container.innerHTML = `
    <div class="mb-2 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
      <div class="rounded bg-slate-900 border border-slate-800 px-2 py-1.5">
        <span class="text-slate-500">Client scope</span>
        <span class="block text-slate-200 font-mono">${escapeHtml(clientScope)}</span>
      </div>
      <div class="rounded bg-slate-900 border border-slate-800 px-2 py-1.5">
        <span class="text-slate-500">Plugin scope</span>
        <span class="block text-slate-200 font-mono">${escapeHtml(pluginScope)}</span>
      </div>
      <div class="rounded bg-slate-900 border border-slate-800 px-2 py-1.5">
        <span class="text-slate-500">Disabled features</span>
        <span class="block text-slate-200 font-mono">${disabledFeatures.length ? disabledFeatures.map(escapeHtml).join(", ") : "none"}</span>
      </div>
    </div>
    ${ordered
      .map((permission) => {
        const sources = Array.isArray(permission.sources) ? permission.sources : [];
        const sourceHtml = sources.length
          ? sources
              .map((source) => `<span class="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[11px] text-slate-300">${escapeHtml(source.label || source.type || "source")}</span>`)
              .join(" ")
          : '<span class="text-xs text-slate-600">No grant source</span>';
        return `
          <div class="rounded border ${permission.allowed ? "border-emerald-900/60 bg-emerald-950/20" : "border-slate-800 bg-slate-900/50"} px-2 py-1.5">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="font-mono text-xs ${permission.allowed ? "text-emerald-200" : "text-slate-400"}">${escapeHtml(permission.id)}</div>
                <div class="text-[11px] text-slate-500">${escapeHtml(permission.description || "")}</div>
              </div>
              <span class="text-[11px] ${permission.allowed ? "text-emerald-300" : "text-slate-600"}">${permission.allowed ? "granted" : "denied"}</span>
            </div>
            <div class="mt-1 flex flex-wrap gap-1">${sourceHtml}</div>
          </div>`;
      })
      .join("")}
  `;
}


async function openUserPermissionsModal(userId, username) {
  editingUserId = userId;
  const modal = document.getElementById("user-perms-modal");
  const title = document.getElementById("user-perms-title");
  const groupsBox = document.getElementById("user-groups-list");
  const effectiveBox = document.getElementById("user-effective-perms-list");
  const extrasBox = document.getElementById("user-extras-list");
  const featuresBox = document.getElementById("user-features-list");
  const errorBox = document.getElementById("user-perms-error");

  title.textContent = `Permissions: ${username}`;
  errorBox.classList.add("hidden");
  groupsBox.innerHTML = `<p class="text-slate-500 text-sm">Loading...</p>`;
  extrasBox.innerHTML = `<p class="text-slate-500 text-sm">Loading...</p>`;
  featuresBox.innerHTML = `<p class="text-slate-500 text-sm">Loading...</p>`;
  effectiveBox.innerHTML = `<p class="text-slate-500 text-sm">Loading...</p>`;
  modal.classList.remove("hidden");

  if (allPermissions.length === 0 || allGroups.length === 0) {
    await loadPermissionsAndGroups();
  }

  try {
    const [groupsRes, extrasRes, effectiveRes, featureRes] = await Promise.all([
      fetch(`/api/users/${userId}/permission-groups`),
      fetch(`/api/users/${userId}/extra-permissions`),
      fetch(`/api/users/${userId}/effective-permissions`),
      fetch(`/api/users/${userId}/feature-permissions`),
    ]);
    const groupsData = await groupsRes.json().catch(() => ({}));
    const extrasData = await extrasRes.json().catch(() => ({}));
    const effectiveData = await effectiveRes.json().catch(() => ({}));
    const featureData = await featureRes.json().catch(() => ({}));
    const targetUser = users.find((candidate) => candidate.id === userId);
    featuresBox.dataset.defaultAllowed = targetUser?.role === "viewer" ? "0" : "1";
    const assignedGroups = new Set(groupsData.groupIds || []);
    const assignedExtras = new Set(extrasData.permissions || []);

    groupsBox.innerHTML = allGroups.length === 0
      ? `<p class="text-slate-500 text-sm">No groups defined yet.</p>`
      : allGroups
          .map(
            (g) => `
        <label class="flex items-start gap-2 py-1 cursor-pointer hover:bg-slate-800/40 rounded px-2">
          <input type="checkbox" class="mt-1 h-4 w-4 accent-violet-500" data-group="${g.id}" ${assignedGroups.has(g.id) ? "checked" : ""} />
          <div>
            <div class="text-sm font-medium text-slate-200">${escapeHtml(g.name)}</div>
            <div class="text-xs text-slate-500">${g.permissions.length} permission${g.permissions.length === 1 ? "" : "s"}</div>
          </div>
        </label>`,
          )
          .join("");

    extrasBox.innerHTML = allPermissions
      .map(
        (p) => `
      <label class="flex items-start gap-2 py-1 cursor-pointer hover:bg-slate-800/40 rounded px-2">
        <input type="checkbox" class="mt-1 h-4 w-4 accent-violet-500" data-perm="${escapeHtml(p.id)}" ${assignedExtras.has(p.id) ? "checked" : ""} />
        <div>
          <div class="text-sm font-mono text-slate-200">${escapeHtml(p.id)}</div>
          <div class="text-xs text-slate-500">${escapeHtml(p.description)}</div>
        </div>
      </label>`,
      )
      .join("");

    const featurePermissions = featureData.permissions || {};
    const features = Array.isArray(featureData.features)
      ? featureData.features
      : Object.keys(featurePermissions);
    featuresBox.innerHTML = features.length === 0
      ? `<p class="text-slate-500 text-sm">No feature gates available.</p>`
      : features
          .map((feature) => {
            const meta = FEATURE_LABELS[feature] || { label: feature, icon: "fa-puzzle-piece" };
            const checked = featurePermissions[feature] !== false;
            return `
      <label class="flex items-center justify-between gap-3 py-2 cursor-pointer hover:bg-slate-800/40 rounded px-2">
        <div class="flex items-center gap-3 min-w-0">
          <i class="fa-solid ${meta.icon} text-slate-400 w-5 text-center"></i>
          <div>
            <div class="text-sm font-medium text-slate-200">${escapeHtml(meta.label)}</div>
            <div class="text-xs font-mono text-slate-500">${escapeHtml(feature)}</div>
          </div>
        </div>
        <input type="checkbox" class="h-4 w-4 accent-blue-500" data-feature="${escapeHtml(feature)}" ${checked ? "checked" : ""} />
      </label>`;
          })
          .join("");

    renderEffectivePermissions(effectiveBox, effectiveData);
  } catch (err) {
    console.error(err);
    errorBox.textContent = "Failed to load current assignments";
    errorBox.classList.remove("hidden");
  }
}

function closeUserPermsModal() {
  document.getElementById("user-perms-modal")?.classList.add("hidden");
  editingUserId = null;
}
document.getElementById("close-user-perms-modal")?.addEventListener("click", closeUserPermsModal);
document.getElementById("user-perms-cancel-btn")?.addEventListener("click", closeUserPermsModal);
document.getElementById("reset-user-features-btn")?.addEventListener("click", () => {
  const featuresBox = document.getElementById("user-features-list");
  const defaultAllowed = featuresBox?.dataset.defaultAllowed !== "0";
  document.querySelectorAll("#user-features-list input[data-feature]").forEach((el) => {
    el.checked = defaultAllowed;
  });
});

document.getElementById("user-perms-save-btn")?.addEventListener("click", async () => {
  if (!editingUserId) return;
  const groupIds = Array.from(
    document.querySelectorAll("#user-groups-list input[type=checkbox]:checked"),
  ).map((el) => Number(el.dataset.group));
  const permissions = Array.from(
    document.querySelectorAll("#user-extras-list input[type=checkbox]:checked"),
  ).map((el) => el.dataset.perm);
  const featurePermissions = {};
  document.querySelectorAll("#user-features-list input[data-feature]").forEach((el) => {
    featurePermissions[el.dataset.feature] = el.checked;
  });
  const errorBox = document.getElementById("user-perms-error");
  errorBox.classList.add("hidden");

  try {
    const [gRes, eRes, fRes] = await Promise.all([
      fetch(`/api/users/${editingUserId}/permission-groups`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupIds }),
      }),
      fetch(`/api/users/${editingUserId}/extra-permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions }),
      }),
      fetch(`/api/users/${editingUserId}/feature-permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: featurePermissions }),
      }),
    ]);
    if (!gRes.ok || !eRes.ok || !fRes.ok) {
      const failed = !gRes.ok ? gRes : (!eRes.ok ? eRes : fRes);
      const data = await failed.json().catch(() => ({}));
      errorBox.textContent = data.error || "Failed to save";
      errorBox.classList.remove("hidden");
      return;
    }
    closeUserPermsModal();
  } catch {
    errorBox.textContent = "Network error";
    errorBox.classList.remove("hidden");
  }
});

getCurrentUser();
loadUsers();
loadPermissionsAndGroups();
