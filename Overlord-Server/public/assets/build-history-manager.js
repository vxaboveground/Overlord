export function formatFileSize(bytes) {
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

export function updateExpirationTimer(timerEl, expiresAt) {
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

export function createBuildHistoryManager({
  buildResults,
  buildFilesDiv,
  getCurrentServerVersion,
  getCurrentUserRole,
  getShowAllBuilds,
}) {
  function isVersionMismatch(versionValue) {
    const currentServerVersion = getCurrentServerVersion();
    if (!currentServerVersion) return false;
    return versionValue !== currentServerVersion;
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

  async function loadSavedBuilds() {
    try {
      const queryParam =
        getShowAllBuilds() && getCurrentUserRole() === "admin" ? "?all=true" : "";
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

  return {
    displayBuild,
    loadSavedBuilds,
    saveBuildToStorage,
  };
}
