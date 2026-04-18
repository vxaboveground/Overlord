export const NAV_MODE_KEY = "sb_mode";

/* ──────────────────────────────────────────────
   NAVIGATION DATA — single source of truth
   ────────────────────────────────────────────── */

const NAV_GROUPS = [
  {
    id: "clients",
    label: "Clients",
    icon: "fa-display",
    iconColor: "text-sky-400",
    href: "/",
    linkId: "nav-clients",
    alwaysVisible: true,
  },
  {
    id: "purgatory",
    label: "Purgatory",
    icon: "fa-user-clock",
    iconColor: "text-amber-400",
    href: "/purgatory",
    linkId: "enrollment-link",
    hasBadge: true,
  },
  {
    id: "system",
    label: "System",
    icon: "fa-gear",
    iconColor: "text-slate-300",
    children: [
      { href: "/logs",           label: "Logs",           icon: "fa-clipboard-list",  iconColor: "text-amber-400",   linkId: "logs-link",           hidden: true },
      { href: "/file-share",     label: "File Share",     icon: "fa-share-nodes",     iconColor: "text-rose-400",    linkId: "file-share-link",     hidden: true },
      { href: "/users",          label: "Users",          icon: "fa-users",           iconColor: "text-indigo-400",  linkId: "users-link",          hidden: true },
      { href: "/notifications",  label: "Notifications",  icon: "fa-bell",            iconColor: "text-yellow-400",  linkId: "notifications-link",  hidden: true },
    ],
  },
  {
    id: "management",
    label: "Management",
    icon: "fa-folder-open",
    iconColor: "text-cyan-400",
    children: [
      { href: "/scripts",        label: "Scripts",        icon: "fa-code",            iconColor: "text-cyan-400",    linkId: "scripts-link" },
      { href: "/socks5-manager", label: "Proxies",        icon: "fa-network-wired",   iconColor: "text-sky-400",     linkId: "socks5-link" },
      { href: "/sol-publish",    label: "Sol Publish",    icon: "fa-link-slash",      iconColor: "text-purple-400",  linkId: "sol-publish-link",    hidden: true },
    ],
  },
  {
    id: "build",
    label: "Build",
    icon: "fa-wrench",
    iconColor: "text-orange-400",
    children: [
      { href: "/build",         label: "Builder",        icon: "fa-hammer",          iconColor: "text-orange-400",  linkId: "build-link",          hidden: true },
      { href: "/plugins",       label: "Plugins",        icon: "fa-puzzle-piece",    iconColor: "text-violet-400",  linkId: "plugins-link",        hidden: true },
    ],
  },
  {
    id: "monitoring",
    label: "Monitoring",
    icon: "fa-chart-line",
    iconColor: "text-emerald-400",
    children: [
      { href: "/metrics",       label: "Metrics",        icon: "fa-chart-line",      iconColor: "text-emerald-400", linkId: "metrics-link" },
    ],
  },
];

/* ──────────────────────────────────────────────
   TOPBAR — dropdown menus
   ────────────────────────────────────────────── */

function dropdownItem(child) {
  const hiddenCls = child.hidden ? " hidden" : "";
  const badgeHtml = child.hasBadge
    ? `<span id="enrollment-badge" class="nav-dd-badge hidden"></span>`
    : "";
  return `<a href="${child.href}" id="${child.linkId}"
      class="nav-dd-item${hiddenCls}" data-link-id="${child.linkId}">
      <i class="fa-solid ${child.icon} ${child.iconColor} nav-dd-item-icon"></i>
      <span>${child.label}</span>
      ${badgeHtml}
    </a>`;
}

function dropdownGroup(group) {
  if (group.href && !group.children) {
    // Simple link (Clients, Purgatory)
    const alwaysCls = group.alwaysVisible ? "" : " hidden";
    const badgeHtml = group.hasBadge
      ? `<span id="enrollment-badge" class="nav-dd-badge hidden"></span>`
      : "";
    return `<a href="${group.href}" id="${group.linkId}"
        class="nav-dd-group-btn${alwaysCls}" data-group="${group.id}">
        <i class="fa-solid ${group.icon} ${group.iconColor}"></i>
        <span>${group.label}</span>
        ${badgeHtml}
      </a>`;
  }
  // Dropdown group — wrapper always visible, children control visibility
  const items = group.children.map(dropdownItem).join("");
  return `
    <div class="nav-dd-wrapper" data-group="${group.id}">
      <button class="nav-dd-group-btn" data-group="${group.id}" aria-haspopup="true" aria-expanded="false">
        <i class="fa-solid ${group.icon} ${group.iconColor}"></i>
        <span>${group.label}</span>
        <i class="fa-solid fa-chevron-down nav-dd-chevron"></i>
      </button>
      <div class="nav-dd-menu">
        ${items}
      </div>
    </div>`;
}

function mountTopbar(host) {
  host.className =
    "sticky top-0 z-10 w-full px-5 py-3 bg-slate-950/80 backdrop-blur border-b border-slate-800";

  const groupsHtml = NAV_GROUPS.map(dropdownGroup).join("");

  host.innerHTML = `
    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3 w-full">
      <div class="flex items-center justify-between gap-3">
        <a href="/" class="flex items-center gap-2 font-semibold tracking-wide">
          <i class="fa-solid fa-crown header-crown"></i> Overlord
        </a>
        <button
          id="nav-toggle"
          class="md:hidden inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/70 border border-slate-700"
          aria-expanded="false"
          aria-controls="nav-panel"
        >
          <i class="fa-solid fa-bars"></i>
          <span>Menu</span>
        </button>
      </div>
      <div
        id="nav-panel"
        class="hidden md:flex md:flex-1 md:items-center md:justify-center gap-3"
      >
        <nav id="nav-links" class="nav-dd-bar">
          ${groupsHtml}
        </nav>
        <div id="nav-utility" class="flex flex-wrap items-center gap-2 md:w-auto md:justify-end md:shrink-0 md:ml-auto">
          <button id="notify-toggle"
            class="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/70 border border-slate-800 text-slate-300 hover:bg-slate-800"
            title="Toggle notifications" aria-label="Toggle notifications">
            <i class="fa-solid fa-bell"></i>
            <span id="notify-badge" class="hidden min-w-[20px] h-5 px-1 rounded-full bg-rose-500 text-white text-xs flex items-center justify-center"></span>
          </button>
          <button id="account-settings-btn"
            class="inline-flex items-center gap-2 px-3 py-2 rounded-full bg-slate-800 text-slate-100 min-w-0 max-w-full md:max-w-none border border-slate-700/70 hover:bg-slate-700 transition-colors"
            title="Open settings" aria-label="Open settings" type="button">
            <i class="fa-solid fa-user-shield text-sky-300"></i>
            <span id="username-display" class="truncate max-w-[110px] sm:max-w-[180px] md:max-w-none">Loading...</span>
            <span id="role-badge" class="text-sm px-2 py-0.5 rounded-full bg-slate-700 shrink-0"></span>
          </button>
          <button id="logout-btn"
            class="group inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/40 hover:bg-red-800/60 text-red-100 border border-red-700/60 transition-colors"
            title="Logout" aria-label="Logout">
            <i class="fa-solid fa-right-from-bracket text-rose-300 group-hover:text-rose-200 transition-colors"></i>
          </button>
          <button id="nav-hide-btn"
            class="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-slate-900/50 border border-slate-800 text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            title="Hide navigation (Ctrl+\\)" aria-label="Hide navigation">
            <i class="fa-solid fa-eye-slash" style="font-size:0.75rem"></i>
          </button>
        </div>
      </div>
    </div>
  `;

  // Collect all link refs
  const refs = {
    toggle: document.getElementById("nav-toggle"),
    panel: document.getElementById("nav-panel"),
    collapseBtn: null,
    navLinks: document.getElementById("nav-links"),
    navUtility: document.getElementById("nav-utility"),
    logoutBtn: document.getElementById("logout-btn"),
    notifyToggle: document.getElementById("notify-toggle"),
    notifyBadge: document.getElementById("notify-badge"),
    accountSettingsBtn: document.getElementById("account-settings-btn"),
    usernameDisplay: document.getElementById("username-display"),
    roleBadge: document.getElementById("role-badge"),
    enrollmentBadge: document.getElementById("enrollment-badge"),
    navHideBtn: document.getElementById("nav-hide-btn"),
  };

  // Add individual link refs
  NAV_GROUPS.forEach((g) => {
    if (g.linkId) refs[g.linkId.replace(/-/g, "") + "Ref"] = document.getElementById(g.linkId);
    if (g.children) {
      g.children.forEach((c) => {
        const key = c.linkId.replace(/-/g, "") + "Ref";
        refs[key] = document.getElementById(c.linkId);
      });
    }
  });

  // Convenience refs expected by nav.js
  refs.usersLink = document.getElementById("users-link");
  refs.buildLink = document.getElementById("build-link");
  refs.solPublishLink = document.getElementById("sol-publish-link");
  refs.pluginsLink = document.getElementById("plugins-link");
  refs.scriptsLink = document.getElementById("scripts-link");
  refs.logsLink = document.getElementById("logs-link");
  refs.notificationsLink = document.getElementById("notifications-link");
  refs.enrollmentLink = document.getElementById("enrollment-link");
  refs.fileShareLink = document.getElementById("file-share-link");

  return refs;
}

/* ──────────────────────────────────────────────
   SIDEBAR — tree-style expandable
   ────────────────────────────────────────────── */

function sidebarChild(child) {
  const hiddenCls = child.hidden ? " hidden" : "";
  const badgeHtml = child.hasBadge
    ? `<span id="enrollment-badge" class="sb-badge hidden"></span>`
    : "";
  return `<a href="${child.href}" id="${child.linkId}"
      class="sb-link sb-link-child${hiddenCls}" data-link-id="${child.linkId}" title="${child.label}">
      <i class="fa-solid ${child.icon} ${child.iconColor} sb-icon"></i>
      <span class="sb-text">${child.label}</span>
      ${badgeHtml}
    </a>`;
}

function sidebarGroup(group) {
  if (group.href && !group.children) {
    // Simple link (Clients, Purgatory)
    const alwaysCls = group.alwaysVisible ? "" : " hidden";
    const badgeHtml = group.hasBadge
      ? `<span id="enrollment-badge" class="sb-badge hidden"></span>`
      : "";
    return `<a href="${group.href}" id="${group.linkId}"
        class="sb-link${alwaysCls}" data-link-id="${group.linkId}" title="${group.label}">
        <i class="fa-solid ${group.icon} ${group.iconColor} sb-icon"></i>
        <span class="sb-text">${group.label}</span>
        ${badgeHtml}
      </a>`;
  }
  // Expandable group — wrapper always visible, children control visibility
  const childrenHtml = group.children.map(sidebarChild).join("");
  return `
    <div class="sb-group" data-group="${group.id}">
      <button class="sb-group-btn" data-group="${group.id}" aria-expanded="false">
        <i class="fa-solid ${group.icon} ${group.iconColor} sb-icon"></i>
        <span class="sb-text">${group.label}</span>
        <i class="fa-solid fa-chevron-right sb-chevron"></i>
      </button>
      <div class="sb-group-children" role="group">
        ${childrenHtml}
      </div>
    </div>`;
}

function mountSidebar(host) {
  const groupsHtml = NAV_GROUPS.map(sidebarGroup).join("");

  host.innerHTML = `
    <div class="sb-header">
      <a href="/" class="sb-logo">
        <i class="fa-solid fa-crown header-crown sb-icon"></i>
        <span class="sb-text">Overlord</span>
      </a>
      <button id="sb-collapse-btn" class="sb-collapse-btn" title="Toggle sidebar" aria-label="Toggle sidebar">
        <i class="fa-solid fa-chevron-left"></i>
      </button>
    </div>

    <nav id="nav-links" class="sb-nav">
      ${groupsHtml}
    </nav>

    <div id="nav-utility" class="sb-utility">
      <button id="notify-toggle" class="sb-link"
        title="Toggle notifications" aria-label="Toggle notifications">
        <span class="sb-notify-wrap sb-icon">
          <i class="fa-solid fa-bell"></i>
          <span id="notify-badge" class="sb-notify-badge hidden"></span>
        </span>
        <span class="sb-text">Notifications</span>
      </button>
      <button id="account-settings-btn" class="sb-link"
        title="Open settings" aria-label="Open settings" type="button">
        <i class="fa-solid fa-user-shield text-sky-300 sb-icon"></i>
        <span class="sb-text">
          <span id="username-display" class="truncate">Loading...</span>
          <span id="role-badge" class="text-xs px-2 py-0.5 rounded-full bg-slate-700 shrink-0"></span>
        </span>
      </button>
      <button id="logout-btn" class="sb-link sb-link--danger"
        title="Logout" aria-label="Logout">
        <i class="fa-solid fa-right-from-bracket sb-icon"></i>
        <span class="sb-text">Logout</span>
      </button>
      <button id="nav-hide-btn" class="sb-link"
        title="Hide navigation (Ctrl+\\)" aria-label="Hide navigation">
        <i class="fa-solid fa-eye-slash sb-icon" style="font-size:0.75rem"></i>
        <span class="sb-text">Hide Nav</span>
      </button>
    </div>
  `;

  // Mobile topbar
  const mobileBar = document.createElement("div");
  mobileBar.id = "sb-mobile-bar";
  mobileBar.innerHTML = `
    <button id="nav-toggle" class="sb-mobile-toggle" aria-label="Open menu">
      <i class="fa-solid fa-bars"></i>
    </button>
    <a href="/" class="sb-mobile-brand">
      <i class="fa-solid fa-crown header-crown" style="font-size:0.85rem"></i>
      <span>Overlord</span>
    </a>
  `;
  host.insertAdjacentElement("afterend", mobileBar);

  // Mobile backdrop
  const backdrop = document.createElement("div");
  backdrop.id = "sb-backdrop";
  document.body.appendChild(backdrop);

  // Collect refs
  const refs = {
    toggle: document.getElementById("nav-toggle"),
    collapseBtn: document.getElementById("sb-collapse-btn"),
    panel: host,
    navLinks: document.getElementById("nav-links"),
    navUtility: document.getElementById("nav-utility"),
    logoutBtn: document.getElementById("logout-btn"),
    notifyToggle: document.getElementById("notify-toggle"),
    notifyBadge: document.getElementById("notify-badge"),
    accountSettingsBtn: document.getElementById("account-settings-btn"),
    usernameDisplay: document.getElementById("username-display"),
    roleBadge: document.getElementById("role-badge"),
    enrollmentBadge: document.getElementById("enrollment-badge"),
    navHideBtn: document.getElementById("nav-hide-btn"),
  };

  // Convenience refs expected by nav.js
  refs.usersLink = document.getElementById("users-link");
  refs.buildLink = document.getElementById("build-link");
  refs.solPublishLink = document.getElementById("sol-publish-link");
  refs.pluginsLink = document.getElementById("plugins-link");
  refs.scriptsLink = document.getElementById("scripts-link");
  refs.logsLink = document.getElementById("logs-link");
  refs.notificationsLink = document.getElementById("notifications-link");
  refs.enrollmentLink = document.getElementById("enrollment-link");
  refs.fileShareLink = document.getElementById("file-share-link");

  return refs;
}

export function mountNav(host) {
  const mode = localStorage.getItem(NAV_MODE_KEY);
  if (mode === "sidebar") {
    return mountSidebar(host);
  }
  return mountTopbar(host);
}

