import {
  startNotificationClient,
  setNotificationsEnabled,
  getNotificationsEnabled,
  subscribeStatus,
  subscribeUnread,
  markAllNotificationsRead,
} from "./notify-client.js";

import { mountNav } from "./nav/template.js";
import { createAdaptiveNavController } from "./nav/layout.js";
import { applyUserRoleUI, applyThumbnailWallVisibility } from "./nav/role-ui.js";
import { loadPluginNavItems } from "./nav/plugins-loader.js";
import { init as initCommandPalette } from "./command-palette.js";
import {
  installPageResourceTracker,
  runWithoutPageTracking,
  setupSoftNavigation,
  startPageTracking,
} from "./soft-nav.js";

const host = document.getElementById("top-nav");
if (host) {
  const refs = mountNav(host);
  initCommandPalette();
  import("./cert-banner.js").then(({ showCertBannerIfNeeded }) => {
    runWithoutPageTracking(() => showCertBannerIfNeeded(document.getElementById("sb-mobile-bar") || host));
  });
  const { applyAdaptiveNavLayout, navHide } = createAdaptiveNavController(host, refs);

  if (refs.navHideBtn && navHide) {
    refs.navHideBtn.addEventListener("click", () => navHide.setHidden(true));
  }

  const path = window.location.pathname;
  const activeMap = {
    "/": "nav-clients",
    "/metrics": "metrics-link",
    "/screenshots": "screenshots-link",
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

  const applyActivePath = (nextPath = window.location.pathname) => {
    host.querySelectorAll(".nav-active").forEach((el) => el.classList.remove("nav-active"));
    host.querySelectorAll(".sb-group-btn[aria-expanded='true']").forEach((btn) => btn.setAttribute("aria-expanded", "false"));
    host.querySelectorAll(".sb-group-children.sb-group-open").forEach((children) => children.classList.remove("sb-group-open"));
    host.querySelectorAll(".sb-chevron.sb-chevron-open").forEach((chevron) => chevron.classList.remove("sb-chevron-open"));
    refs.accountSettingsBtn?.classList.remove("ring-1", "ring-sky-500/60", "bg-slate-700");

    const activeId = activeMap[nextPath];
    if (activeId) {
      const el = document.getElementById(activeId);
      if (el) {
        el.classList.add("nav-active");
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

    if (nextPath === "/settings" && refs.accountSettingsBtn) {
      refs.accountSettingsBtn.classList.add("ring-1", "ring-sky-500/60", "bg-slate-700");
    }
  };

  loadPluginNavItems(activeMap).then(() => {
    applyActivePath(path);
  });

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
      if (window.overlordSoftNavigate) {
        window.overlordSoftNavigate("/settings");
      } else {
        window.location.href = "/settings";
      }
    });
  }

  const updateToggle = () => {
    const enabled = getNotificationsEnabled();
    if (refs.notifyToggle) {
      refs.notifyToggle.classList.toggle("text-emerald-200", enabled);
      refs.notifyToggle.classList.toggle("border-emerald-500/40", enabled);
      refs.notifyToggle.classList.toggle("text-slate-300", !enabled);
    }
  };

  let lastNotifyClickTime = 0;
  const DOUBLE_CLICK_WINDOW_MS = 700;
  refs.notifyToggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    const now = Date.now();
    const isSecondClick = now - lastNotifyClickTime < DOUBLE_CLICK_WINDOW_MS;
    lastNotifyClickTime = isSecondClick ? 0 : now;

    const next = !getNotificationsEnabled();
    setNotificationsEnabled(next);
    updateToggle();

    if (isSecondClick) {
      markAllNotificationsRead();
    }
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

  const prefetchedPages = new Set();
  const prefetchPage = (href) => {
    try {
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      const key = `${url.pathname}${url.search}`;
      if (prefetchedPages.has(key)) return;
      prefetchedPages.add(key);
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.as = "document";
      link.href = key;
      document.head.appendChild(link);
    } catch {}
  };

  host.addEventListener("pointerenter", (event) => {
    const link = event.target?.closest?.("a[href]");
    if (link) prefetchPage(link.getAttribute("href"));
  }, true);
  host.addEventListener("focusin", (event) => {
    const link = event.target?.closest?.("a[href]");
    if (link) prefetchPage(link.getAttribute("href"));
  });

  async function loadCurrentUser() {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (!res.ok) {
        return;
      }
      const user = await res.json();
      applyUserRoleUI(user, refs);
      applyThumbnailWallVisibility(user);

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

  import("./chat-widget.js").then((chatWidget) => {
    runWithoutPageTracking(() => {
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
    });
  });

  installPageResourceTracker();
  setupSoftNavigation(host, { onPathChange: applyActivePath });
  startPageTracking();
}
