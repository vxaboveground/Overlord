const DISMISS_KEY = "overlord_cert_banner_dismissed";


export async function showCertBannerIfNeeded(anchor) {
  if (sessionStorage.getItem(DISMISS_KEY) === "1") return;
  if (localStorage.getItem(DISMISS_KEY) === "1") return;

  let source;
  try {
    const res = await fetch("/api/cert/info");
    if (!res.ok) return;
    const data = await res.json();
    source = data.source;
  } catch {
    return;
  }

  if (source !== "self-signed") return;

  if ("serviceWorker" in navigator && window.isSecureContext) {
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      if (reg && reg.active) {
        return;
      }
    } catch { }
  }

  const os = detectOS();

  const banner = document.createElement("div");
  banner.id = "cert-trust-banner";
  banner.className =
    "mx-4 mt-3 mb-1 flex items-start gap-3 rounded-lg border border-amber-500/30 " +
    "bg-amber-950/60 px-4 py-3 text-sm text-amber-200 shadow-lg";

  banner.innerHTML = `
    <span class="mt-0.5 text-lg select-none">&#x26A0;&#xFE0F;</span>
    <div class="flex-1 min-w-0">
      <p class="font-semibold text-amber-100 mb-1">Untrusted self-signed certificate</p>
      <p class="mb-2 text-amber-200/80 leading-relaxed">
        This server is using a self-signed TLS certificate.  Your browser doesn't
        trust it, which may block some features (desktop notifications, service workers).
        Download the certificate and add it to your OS / browser trust store to fix this.
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <a href="/api/cert/download"
           download="overlord-ca.crt"
           class="inline-flex items-center gap-1.5 rounded bg-amber-600 hover:bg-amber-500
                  px-3 py-1 text-xs font-medium text-white transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2"
               viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round"
               d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3"/></svg>
          Download Certificate
        </a>
        <button id="cert-banner-how" type="button"
                class="text-xs text-amber-300 underline underline-offset-2 hover:text-amber-100 transition-colors">
          How to install (${os.label})
        </button>
      </div>
      <div id="cert-banner-instructions" class="hidden mt-2 rounded bg-slate-900/80
            border border-slate-700/50 p-3 text-xs text-slate-300 leading-relaxed whitespace-pre-line">${os.instructions}</div>
    </div>
    <button id="cert-banner-dismiss" type="button"
            class="ml-2 mt-0.5 text-amber-400 hover:text-amber-200 transition-colors"
            aria-label="Dismiss">&times;</button>
  `;

  anchor.insertAdjacentElement("afterend", banner);

  document.getElementById("cert-banner-dismiss")?.addEventListener("click", () => {
    banner.remove();
    localStorage.setItem(DISMISS_KEY, "1");
    sessionStorage.setItem(DISMISS_KEY, "1");
  });

  document.getElementById("cert-banner-how")?.addEventListener("click", () => {
    const el = document.getElementById("cert-banner-instructions");
    if (el) el.classList.toggle("hidden");
  });
}

function detectOS() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) {
    return {
      label: "Windows",
      instructions:
`1. Double-click the downloaded <strong>overlord-ca.crt</strong> file.
2. Click <strong>Install Certificate...</strong>
3. Choose <strong>Current User</strong> or <strong>Local Machine</strong>.
4. Select <strong>"Place all certificates in the following store"</strong>.
5. Click <strong>Browse</strong> → choose <strong>Trusted Root Certification Authorities</strong>.
6. Click <strong>Next</strong> → <strong>Finish</strong>.
7. <strong>Restart your browser</strong> for the change to take effect.`,
    };
  }
  if (ua.includes("mac")) {
    return {
      label: "macOS",
      instructions:
`1. Double-click the downloaded <strong>overlord-ca.crt</strong> file — it opens in Keychain Access.
2. If prompted, add it to the <strong>login</strong> or <strong>System</strong> keychain.
3. Find the certificate in the list, double-click it.
4. Expand <strong>Trust</strong> and set <strong>"When using this certificate"</strong> to <strong>Always Trust</strong>.
5. Close the dialog (you'll be prompted for your password).
6. <strong>Restart your browser</strong>.`,
    };
  }
  return {
    label: "Linux",
    instructions:
`<strong>Debian / Ubuntu:</strong>
  sudo cp overlord-ca.crt /usr/local/share/ca-certificates/overlord-ca.crt
  sudo update-ca-certificates

<strong>Fedora / RHEL:</strong>
  sudo cp overlord-ca.crt /etc/pki/ca-trust/source/anchors/overlord-ca.crt
  sudo update-ca-trust

Then <strong>restart your browser</strong>.
For Chrome/Chromium you may also need: Settings → Privacy → Manage Certificates → Authorities → Import.`,
  };
}
