const STATUS_TONES = {
  idle: {
    box: "bg-slate-900/50 border-slate-700/60",
    icon: "fa-solid fa-circle text-slate-400",
  },
  running: {
    box: "bg-blue-900/40 border-blue-700/60",
    icon: "fa-solid fa-spinner fa-spin",
  },
  success: {
    box: "bg-green-900/40 border-green-700/60",
    icon: "fa-solid fa-circle-check",
  },
  error: {
    box: "bg-red-900/40 border-red-700/60",
    icon: "fa-solid fa-circle-xmark",
  },
  warning: {
    box: "bg-amber-900/40 border-amber-700/60",
    icon: "fa-solid fa-triangle-exclamation",
  },
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function setStatusPanel(root, { state = "idle", text = "", icon } = {}) {
  if (!root) return;
  const tone = STATUS_TONES[state] || STATUS_TONES.idle;
  const box = root.querySelector("div");
  const iconEl = root.querySelector("i");
  const textEl = root.querySelector("span");

  root.classList.remove("hidden");
  if (box) box.className = `flex items-center gap-2 p-3 rounded-lg border ${tone.box}`;
  if (iconEl) iconEl.className = icon || tone.icon;
  if (textEl) textEl.textContent = text;
}

export function setActionButton(button, { disabled = false, busy = false, icon, label } = {}) {
  if (!button) return;
  button.disabled = !!disabled;
  const nextIcon = busy ? "fa-solid fa-spinner fa-spin" : icon;
  const nextLabel = label ?? button.textContent?.trim() ?? "";
  button.innerHTML = `${nextIcon ? `<i class="${escapeHtml(nextIcon)}"></i> ` : ""}<span>${escapeHtml(nextLabel)}</span>`;
}
