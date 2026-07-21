const DENY_LABELS = {
  feature: "You do not have permission to access this feature.",
  client: "You do not have access to this client.",
};

/**
 * @param {string} feature
 * @param {string} clientId
 * @returns {Promise<boolean>}
 */
export async function checkFeatureAccess(feature, clientId) {
  try {
    const params = new URLSearchParams({ feature, clientId });
    const res = await fetch(`/api/auth/feature-check?${params}`, { credentials: "include" });

    if (res.status === 401) {
      window.location.href = "/";
      return false;
    }

    if (!res.ok) return true;

    const data = await res.json();
    if (data.allowed) return true;

    const reasons = Array.isArray(data.denialDetails) && data.denialDetails.length
      ? data.denialDetails
      : (Array.isArray(data.denied) ? data.denied : []);
    showAccessDenied(reasons);
    return false;
  } catch {
    return true;
  }
}

function showAccessDenied(reasons) {
  const messages = reasons
    .map((reason) => {
      if (typeof reason === "string") return DENY_LABELS[reason] || "Access denied.";
      if (reason && typeof reason.message === "string") return reason.message;
      return "Access denied.";
    })
    .join(" ");

  document.body.style.visibility = "hidden";

  const overlay = document.createElement("div");
  overlay.id = "access-denied-overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:#0f172a;visibility:visible;";

  const card = document.createElement("div");
  card.style.cssText =
    "max-width:420px;width:90%;text-align:center;padding:2rem;border-radius:1rem;background:#1e293b;border:1px solid #dc2626;";

  card.innerHTML = `
    <div style="font-size:3rem;margin-bottom:1rem;">
      <i class="fa-solid fa-lock" style="color:#ef4444;"></i>
    </div>
    <h2 style="font-size:1.25rem;font-weight:700;color:#f1f5f9;margin-bottom:0.5rem;">Access Denied</h2>
    <p style="color:#94a3b8;font-size:0.875rem;line-height:1.5;margin-bottom:1.5rem;">
      ${escapeHtml(messages)}
    </p>
    <p style="color:#64748b;font-size:0.75rem;margin-bottom:1.25rem;">
      Contact your administrator to request access.
    </p>
  `;

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close Tab";
  closeBtn.style.cssText =
    "padding:0.5rem 1.25rem;border-radius:0.5rem;background:#334155;color:#e2e8f0;border:1px solid #475569;cursor:pointer;font-size:0.875rem;";
  closeBtn.addEventListener("click", () => window.close());

  card.appendChild(closeBtn);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

function escapeHtml(text) {
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML;
}
