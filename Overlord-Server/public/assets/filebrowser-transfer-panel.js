import { formatBytes } from "./filebrowser-utils.js";

export function createTransferPanel({ onCancel }) {
  const transferPanel = document.getElementById("transfer-panel");
  const transferList = document.getElementById("transfer-list");

  function addTransferToUI(transfer) {
    if (!transferPanel || !transferList) return;
    const transferItem = document.createElement("div");
    transferItem.id = `transfer-${transfer.id}`;
    transferItem.className =
      "transfer-item bg-slate-800/50 border border-slate-700 rounded-lg p-3";

    const icon = transfer.type === "upload" ? "fa-upload" : "fa-download";
    const color = transfer.type === "upload" ? "text-blue-400" : "text-green-400";

    transferItem.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-2 flex-1 min-w-0">
          <i class="fa-solid ${icon} ${color}"></i>
          <span class="text-sm truncate transfer-name"></span>
        </div>
        <button class="cancel-btn text-red-400 hover:text-red-300 px-2" type="button">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="progress-bar-container w-full bg-slate-700 rounded-full h-2 mb-1">
        <div class="progress-bar bg-blue-500 h-2 rounded-full transition-all duration-300" style="width: ${transfer.progress}%"></div>
      </div>
      <div class="flex justify-between text-xs text-slate-400">
        <span class="progress-text">${transfer.progress}%</span>
        <span class="size-text">${formatBytes(transfer.sent || transfer.received || 0)} / ${formatBytes(transfer.total)}</span>
      </div>
    `;

    const nameEl = transferItem.querySelector(".transfer-name");
    if (nameEl) {
      nameEl.textContent = transfer.fileName;
    }
    const cancelBtn = transferItem.querySelector(".cancel-btn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => onCancel(transfer.id));
    }

    transferList.appendChild(transferItem);
    transferPanel.classList.remove("hidden");
  }

  function updateTransferProgress(transferId, progress, current, total) {
    const transferItem = document.getElementById(`transfer-${transferId}`);
    if (!transferItem) return;

    const progressBar = transferItem.querySelector(".progress-bar");
    const progressText = transferItem.querySelector(".progress-text");
    const sizeText = transferItem.querySelector(".size-text");

    if (progressBar) progressBar.style.width = `${progress}%`;
    if (progressText) progressText.textContent = `${progress}%`;
    if (sizeText) {
      sizeText.textContent = `${formatBytes(current)} / ${formatBytes(total)}`;
    }
  }

  function removeTransfer(transferId) {
    const transferItem = document.getElementById(`transfer-${transferId}`);
    if (transferItem) {
      transferItem.remove();
    }

    if (transferList && transferList.children.length === 0) {
      transferPanel?.classList.add("hidden");
    }
  }

  return {
    addTransferToUI,
    removeTransfer,
    updateTransferProgress,
  };
}
