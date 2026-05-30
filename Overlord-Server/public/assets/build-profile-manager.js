const PROFILE_EXPORT_MAGIC = "overlord-build-profile";

function sanitizeProfileName(name) {
  if (typeof name !== "string") return "";
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 64) return "";
  if (!/^[A-Za-z0-9 _.-]+$/.test(trimmed)) return "";
  return trimmed;
}

function exportProfileToFile(name, config) {
  const payload = {
    type: PROFILE_EXPORT_MAGIC,
    version: 1,
    name,
    exportedAt: Date.now(),
    config,
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = (name || "build-profile").replace(/[^A-Za-z0-9._-]/g, "_");
  a.href = url;
  a.download = `${safeName}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function createBuildProfileManager({
  elements,
  collectFormSettings,
  applyFormSettings,
  saveFormSettings,
}) {
  const {
    profileSelect,
    profileNameInput,
    profileSaveBtn,
    profileLoadBtn,
    profileDeleteBtn,
    profileExportBtn,
    profileImportBtn,
    profileImportFile,
  } = elements;

  let buildProfiles = [];

  function renderProfileOptions(selectedName = "") {
    if (!profileSelect) return;
    profileSelect.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a saved profile...";
    profileSelect.appendChild(placeholder);

    buildProfiles.forEach((profile) => {
      const option = document.createElement("option");
      option.value = profile.name;
      option.textContent = profile.name;
      if (selectedName && selectedName === profile.name) option.selected = true;
      profileSelect.appendChild(option);
    });
  }

  function getSelectedProfile() {
    if (!profileSelect || !profileSelect.value) return null;
    return buildProfiles.find((profile) => profile.name === profileSelect.value) || null;
  }

  async function loadBuildProfiles(selectedName = "") {
    try {
      const res = await fetch("/api/build/profiles", { credentials: "include" });
      if (!res.ok) {
        buildProfiles = [];
        renderProfileOptions();
        return;
      }
      const data = await res.json();
      buildProfiles = Array.isArray(data?.profiles) ? data.profiles : [];
      renderProfileOptions(selectedName || profileSelect?.value || "");
    } catch (err) {
      console.error("Failed to load build profiles:", err);
      buildProfiles = [];
      renderProfileOptions();
    }
  }

  async function saveCurrentProfile() {
    const inputName = profileNameInput?.value || "";
    const selectedName = profileSelect?.value || "";
    const profileName = sanitizeProfileName(inputName || selectedName);
    if (!profileName) {
      alert("Enter a valid profile name (1-64 chars; letters, numbers, spaces, . _ -)");
      profileNameInput?.focus();
      return;
    }

    const config = collectFormSettings();

    const res = await fetch("/api/build/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ name: profileName, config }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to save profile");
    }

    if (profileNameInput) profileNameInput.value = profileName;
    await loadBuildProfiles(profileName);
  }

  async function importProfileFromFile(file) {
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON file");
    }

    const fallbackName = file.name.replace(/\.json$/i, "");
    const importedName = sanitizeProfileName(parsed?.name || fallbackName);
    if (!importedName) {
      throw new Error("Invalid profile name in imported file");
    }

    const importedConfig = parsed?.config;
    if (!importedConfig || typeof importedConfig !== "object" || Array.isArray(importedConfig)) {
      throw new Error("Imported profile is missing a valid config object");
    }

    applyFormSettings(importedConfig);
    saveFormSettings();

    if (profileNameInput) profileNameInput.value = importedName;
    await saveCurrentProfile();
  }

  function bindProfileControls() {
    if (profileSelect) {
      profileSelect.addEventListener("change", () => {
        const profile = getSelectedProfile();
        if (profileNameInput) {
          profileNameInput.value = profile?.name || "";
        }
      });
    }

    if (profileSaveBtn) {
      profileSaveBtn.addEventListener("click", async () => {
        try {
          await saveCurrentProfile();
          alert("Profile saved.");
        } catch (err) {
          alert(err?.message || "Failed to save profile");
        }
      });
    }

    if (profileLoadBtn) {
      profileLoadBtn.addEventListener("click", () => {
        const profile = getSelectedProfile();
        if (!profile) {
          alert("Select a profile to load.");
          return;
        }
        applyFormSettings(profile.config || {});
        saveFormSettings();
        if (profileNameInput) profileNameInput.value = profile.name;
        alert(`Loaded profile: ${profile.name}`);
      });
    }

    if (profileDeleteBtn) {
      profileDeleteBtn.addEventListener("click", async () => {
        const profile = getSelectedProfile();
        if (!profile) {
          alert("Select a profile to delete.");
          return;
        }
        if (!confirm(`Delete profile \"${profile.name}\"?`)) {
          return;
        }
        try {
          const res = await fetch(`/api/build/profiles/${encodeURIComponent(profile.name)}`, {
            method: "DELETE",
            credentials: "include",
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || "Failed to delete profile");
          }
          await loadBuildProfiles();
          if (profileNameInput) profileNameInput.value = "";
          alert("Profile deleted.");
        } catch (err) {
          alert(err?.message || "Failed to delete profile");
        }
      });
    }

    if (profileExportBtn) {
      profileExportBtn.addEventListener("click", () => {
        const profile = getSelectedProfile();
        if (profile) {
          exportProfileToFile(profile.name, profile.config || {});
          return;
        }
        const fallbackName = sanitizeProfileName(profileNameInput?.value || "") || "current-build-profile";
        exportProfileToFile(fallbackName, collectFormSettings());
      });
    }

    if (profileImportBtn && profileImportFile) {
      profileImportBtn.addEventListener("click", () => profileImportFile.click());
      profileImportFile.addEventListener("change", async () => {
        const file = profileImportFile.files?.[0];
        profileImportFile.value = "";
        if (!file) return;
        try {
          await importProfileFromFile(file);
          alert("Profile imported and saved.");
        } catch (err) {
          alert(err?.message || "Failed to import profile");
        }
      });
    }
  }

  return {
    bindProfileControls,
    loadBuildProfiles,
    sanitizeProfileName,
  };
}
