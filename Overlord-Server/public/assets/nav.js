import {
  startNotificationClient,
  setNotificationsEnabled,
  getNotificationsEnabled,
  subscribeStatus,
  subscribeUnread,
} from "./notify-client.js";

import { mountNav } from "./nav/template.js";
import { createAdaptiveNavController } from "./nav/layout.js";
import { applyUserRoleUI } from "./nav/role-ui.js";
import { showCertBannerIfNeeded } from "./cert-banner.js";
import * as chatWidget from "./chat-widget.js";

const host = document.getElementById("top-nav");
if (host) {
  const refs = mountNav(host);
  showCertBannerIfNeeded(document.getElementById("sb-mobile-bar") || host);
  const { applyAdaptiveNavLayout, navHide } = createAdaptiveNavController(host, refs);

  if (refs.navHideBtn && navHide) {
    refs.navHideBtn.addEventListener("click", () => navHide.setHidden(true));
  }

  const path = window.location.pathname;
  const activeMap = {
    "/": "nav-clients",
    "/metrics": "metrics-link",
    "/logs": "logs-link",
    "/scripts": "scripts-link",
    "/socks5-manager": "socks5-link",
    "/plugins": "plugins-link",
    "/build": "build-link",
    "/sol-publish": "sol-publish-link",
    "/users": "users-link",
    "/user-client-access": "users-link",
    "/notifications": "notifications-link",
    "/file-share": "file-share-link",
    "/purgatory": "enrollment-link",
  };
  const activeId = activeMap[path];
  if (activeId) {
    const el = document.getElementById(activeId);
    if (el) {
      el.classList.add("nav-active");
      // Also expand the parent sidebar group if applicable
      const group = el.closest(".sb-group");
      if (group) {
        const btn = group.querySelector(".sb-group-btn");
        const children = group.querySelector(".sb-group-children");
        const chevron = btn?.querySelector(".sb-chevron");
        if (btn) btn.setAttribute("aria-expanded", "true");
        if (children) children.classList.add("sb-group-open");
        if (chevron) chevron.classList.add("sb-chevron-open");
      }
    }
  }
  if (refs.logoutBtn && !refs.logoutBtn.dataset.boundLogout) {
    refs.logoutBtn.dataset.boundLogout = "true";
    refs.logoutBtn.addEventListener("click", async () => {
      if (!confirm("Are you sure you want to logout?")) return;

      try {
        const res = await fetch("/api/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });


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

  if (refs.accountSettingsBtn && !refs.accountSettingsBtn.dataset.boundSettings) {
    refs.accountSettingsBtn.dataset.boundSettings = "true";
    refs.accountSettingsBtn.addEventListener("click", () => {
      window.location.href = "/settings";
    });
  }

  if (path === "/settings" && refs.accountSettingsBtn) {
    refs.accountSettingsBtn.classList.add("ring-1", "ring-sky-500/60", "bg-slate-700");
  }

  const updateToggle = () => {
    const enabled = getNotificationsEnabled();
    if (refs.notifyToggle) {
      refs.notifyToggle.classList.toggle("text-emerald-200", enabled);
      refs.notifyToggle.classList.toggle("border-emerald-500/40", enabled);
      refs.notifyToggle.classList.toggle("text-slate-300", !enabled);
    }
  };

  refs.notifyToggle?.addEventListener("click", () => {
    const next = !getNotificationsEnabled();
    setNotificationsEnabled(next);
    updateToggle();
  });

  subscribeUnread((count) => {
    if (!refs.notifyBadge) return;
    refs.notifyBadge.textContent = String(count);
    refs.notifyBadge.classList.toggle("hidden", count <= 0);
  });

  updateToggle();
  startNotificationClient();
  subscribeStatus((status) => {
    if (status === "connected") {
      // no-op
    }
  });

  async function loadCurrentUser() {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (!res.ok) {
        return;
      }
      const user = await res.json();
      applyUserRoleUI(user, refs);

      if (user.role === "admin" || user.role === "operator") {
        try {
          const statsRes = await fetch("/api/enrollment/stats", { credentials: "include" });
          if (statsRes.ok) {
            const stats = await statsRes.json();
            const badge = refs.enrollmentBadge;
            if (badge) {
              if (stats.pending > 0) {
                badge.textContent = stats.pending;
                badge.classList.remove("hidden");
              } else {
                badge.classList.add("hidden");
              }
            }
          }
        } catch {}
      }

      applyAdaptiveNavLayout();
    } catch (err) {
      console.error("Failed to load user:", err);
    }
  }

  if (refs.usernameDisplay && refs.roleBadge) {
    loadCurrentUser();
  }

  chatWidget.init();

  if (chatWidget.isHidden() && refs.navUtility) {
    const restoreBtn = document.createElement("button");
    restoreBtn.id = "chat-restore-btn";
    restoreBtn.className = "inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/70 border border-slate-800 text-slate-500 hover:text-slate-300 hover:bg-slate-800 text-xs transition-colors";
    restoreBtn.title = "Show team chat";
    restoreBtn.innerHTML = '<i class="fa-solid fa-comments"></i><span class="sb-text">Chat</span>';
    restoreBtn.addEventListener("click", () => {
      chatWidget.show();
      restoreBtn.remove();
    });
    refs.navUtility.insertBefore(restoreBtn, refs.navUtility.firstChild);
  }
}
