import type { AuthenticatedUser } from "../../auth";
import { checkPermission, getPermissionDescription, type Permission } from "../../rbac";
import { escapeHtml } from "./html";

type PermissionGroup = {
  title: string;
  icon: string;
  perms: Permission[];
};

const GROUPS: PermissionGroup[] = [
  {
    title: "User Administration",
    icon: "fa-users-gear",
    perms: ["users:manage", "audit:view"],
  },
  {
    title: "Client Operations",
    icon: "fa-desktop",
    perms: [
      "clients:control",
      "clients:build",
      "clients:metadata",
      "clients:disconnect",
      "clients:reconnect",
      "clients:uninstall",
      "clients:elevate",
      "clients:winre",
    ],
  },
  {
    title: "System Settings",
    icon: "fa-sliders",
    perms: [
      "system:security",
      "system:tls",
      "system:oidc",
      "system:registration",
      "system:notifications",
      "system:chat",
      "system:appearance",
      "system:thumbnails",
      "system:input-archive",
      "system:build-limits",
      "system:export-import",
      "system:health",
      "system:health:manage",
      "system:profiler",
    ],
  },
];

function renderPermissionRow(user: AuthenticatedUser, permission: Permission): string {
  const has = checkPermission(user, permission);
  return `<div class="flex items-start justify-between gap-3 rounded bg-slate-950/70 border border-slate-800 px-3 py-2">
    <div class="min-w-0">
      <div class="font-mono text-xs ${has ? "text-slate-100" : "text-slate-500"}">${escapeHtml(permission)}</div>
      <div class="text-[11px] text-slate-500 leading-snug">${escapeHtml(getPermissionDescription(permission))}</div>
    </div>
    <span class="shrink-0 text-xs ${has ? "text-emerald-300" : "text-slate-600"}" aria-label="${has ? "Granted" : "Not granted"}">
      <i class="fa-solid ${has ? "fa-circle-check" : "fa-circle-minus"}"></i>
    </span>
  </div>`;
}

function renderGroup(user: AuthenticatedUser, group: PermissionGroup): string {
  const rows = group.perms.map((permission) => renderPermissionRow(user, permission)).join("");
  return `<div class="rounded-lg border border-slate-800 bg-slate-900/70 p-3">
    <h3 class="text-sm font-semibold mb-3 flex items-center gap-2">
      <i class="fa-solid ${group.icon} text-violet-400"></i>${escapeHtml(group.title)}
    </h3>
    <div class="space-y-2">${rows}</div>
  </div>`;
}

export function renderPermissionsOverviewFrame(user: AuthenticatedUser): string {
  const groups = GROUPS.map((group) => renderGroup(user, group)).join("");
  return `<turbo-frame id="section-permissions-overview" data-permission="users:manage" class="block bg-slate-900/60 border border-slate-800 rounded-xl p-5 space-y-4 settings-section">
    <div class="flex items-center gap-3">
      <div class="flex items-center justify-center w-9 h-9 rounded-lg bg-violet-500/10 border border-violet-500/30">
        <i class="fa-solid fa-user-shield text-violet-400"></i>
      </div>
      <div>
        <h2 class="text-lg font-semibold">Access Overview</h2>
        <p class="text-sm text-slate-400">Review your effective permissions and jump to user access management.</p>
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">${groups}</div>
    <div class="flex flex-wrap items-center gap-3">
      <a href="/users" class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-700 hover:bg-violet-600 text-white text-sm font-medium">
        <i class="fa-solid fa-users-gear"></i> Manage Users
      </a>
      <span class="text-xs text-slate-500">Permission groups and per-user overrides are managed on the Users page.</span>
    </div>
  </turbo-frame>`;
}
