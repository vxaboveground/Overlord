const rpcSelect = document.getElementById("rpc-url");
const customRpcWrapper = document.getElementById("custom-rpc-wrapper");
const customRpcInput = document.getElementById("custom-rpc-url");
const privateKeyInput = document.getElementById("private-key");
const toggleKeyBtn = document.getElementById("toggle-key-visibility");
const serverUrlInput = document.getElementById("server-url");
const previewBtn = document.getElementById("preview-btn");
const publishBtn = document.getElementById("publish-btn");
const outputSection = document.getElementById("output-section");
const outputDiv = document.getElementById("output");
const walletInfo = document.getElementById("wallet-info");
const walletAddress = document.getElementById("wallet-address");
const walletBalance = document.getElementById("wallet-balance");

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function decodeBase58(str) {
  const bytes = [0];
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 character: ${char}`);
    let carry = idx;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of str) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

function encodeBase58(buffer) {
  const digits = [0];
  for (const byte of buffer) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    digits.push(0);
  }
  return digits.reverse().map((d) => BASE58_ALPHABET[d]).join("");
}

async function loadRpcEndpoints() {
  const fallbackEndpoints = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
    "https://api.devnet.solana.com",
  ];
  let loadedEndpoints = false;

  try {
    const res = await fetch("/api/sol/rpc-endpoints", { credentials: "include" });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.endpoints) && data.endpoints.length > 0) {
        data.endpoints.forEach((ep) => {
          const opt = document.createElement("option");
          opt.value = ep;
          opt.textContent = ep;
          rpcSelect.appendChild(opt);
        });
        loadedEndpoints = true;
      }
    }
  } catch {}

  if (!loadedEndpoints) {
    fallbackEndpoints.forEach((ep) => {
      const opt = document.createElement("option");
      opt.value = ep;
      opt.textContent = ep;
      rpcSelect.appendChild(opt);
    });
  }

  const customOpt = document.createElement("option");
  customOpt.value = "__custom__";
  customOpt.textContent = "Custom RPC endpoint...";
  rpcSelect.appendChild(customOpt);
}

loadRpcEndpoints();

rpcSelect.addEventListener("change", () => {
  customRpcWrapper.classList.toggle("hidden", rpcSelect.value !== "__custom__");
});

function getSelectedRpc() {
  if (rpcSelect.value === "__custom__") {
    return customRpcInput.value.trim();
  }
  return rpcSelect.value;
}

const isHttps = window.location.protocol === "https:";
const host = window.location.host;
serverUrlInput.value = `${isHttps ? "wss" : "ws"}://${host}`;

let keyVisible = false;
toggleKeyBtn.addEventListener("click", () => {
  keyVisible = !keyVisible;
  privateKeyInput.type = keyVisible ? "text" : "password";
  toggleKeyBtn.innerHTML = keyVisible
    ? '<i class="fa-solid fa-eye-slash"></i> Hide'
    : '<i class="fa-solid fa-eye"></i> Show';
});

let balanceTimeout = null;
privateKeyInput.addEventListener("input", () => {
  clearTimeout(balanceTimeout);
  balanceTimeout = setTimeout(checkWalletBalance, 800);
});

function showWalletInfo(publicKey, balanceSol) {
  walletAddress.textContent = `Address: ${publicKey}`;
  walletBalance.textContent = balanceSol != null ? `Balance: ${balanceSol} SOL` : "";
  walletInfo.classList.remove("hidden");
}

async function checkWalletBalance() {
  const key = privateKeyInput.value.trim();
  if (!key || key.length < 32) {
    walletInfo.classList.add("hidden");
    return;
  }

  let publicKey = key;
  try {
    const decoded = decodeBase58(key);
    if (decoded.length === 64) {
      publicKey = encodeBase58(decoded.slice(32));
    } else if (decoded.length !== 32) {
      walletInfo.classList.add("hidden");
      return;
    }
  } catch {
    walletInfo.classList.add("hidden");
    return;
  }

  try {
    const rpc = getSelectedRpc();
    const res = await fetch("/api/sol/balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ publicKeyBase58: publicKey, rpcUrl: rpc }),
    });

    if (!res.ok) {
      walletInfo.classList.add("hidden");
      return;
    }

    const data = await res.json();
    if (data && typeof data.balanceSol === "number") {
      showWalletInfo(publicKey, data.balanceSol);
    } else {
      walletInfo.classList.add("hidden");
    }
  } catch {
    walletInfo.classList.add("hidden");
  }
}

function showOutput(text, isError = false) {
  outputSection.classList.remove("hidden");
  outputDiv.textContent = text;
  outputDiv.className = `p-3 bg-slate-800/60 border rounded-lg text-sm font-mono break-all whitespace-pre-wrap max-h-64 overflow-y-auto ${
    isError ? "border-red-700/60 text-red-300" : "border-slate-700 text-slate-200"
  }`;
}

previewBtn.addEventListener("click", async () => {
  const serverUrl = serverUrlInput.value.trim();
  if (!serverUrl) {
    showOutput("Error: Server URL is required", true);
    return;
  }

  previewBtn.disabled = true;
  previewBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Encrypting...';

  try {
    const res = await fetch("/api/sol/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ serverUrl }),
    });

    const data = await res.json();
    if (!res.ok) {
      showOutput(`Error: ${data.error}`, true);
      return;
    }

    showOutput(
      `Encrypted Memo (${data.memoLength} chars):\n\n${data.memo}\n\nThis is what would be stored in the Solana memo transaction.`
    );
  } catch (err) {
    showOutput(`Error: ${err.message}`, true);
  } finally {
    previewBtn.disabled = false;
    previewBtn.innerHTML = '<i class="fa-solid fa-eye"></i> Preview Memo';
  }
});

publishBtn.addEventListener("click", async () => {
  const serverUrl = serverUrlInput.value.trim();
  const privateKey = privateKeyInput.value.trim();
  const rpcUrl = getSelectedRpc();

  if (!serverUrl) {
    showOutput("Error: Server URL is required", true);
    return;
  }
  if (!privateKey) {
    showOutput("Error: Private key is required", true);
    return;
  }
  if (!rpcUrl) {
    showOutput("Error: RPC endpoint is required", true);
    return;
  }

  if (!confirm(
    "Publish encrypted server URL to Solana?\n\n" +
    `Server URL: ${serverUrl}\n` +
    `RPC: ${rpcUrl}\n\n` +
    "This will create a transaction costing ~0.000005 SOL."
  )) {
    return;
  }

  publishBtn.disabled = true;
  publishBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Publishing...';

  try {
    const res = await fetch("/api/sol/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ serverUrl, privateKeyBase58: privateKey, rpcUrl }),
    });

    const data = await res.json();
    if (!res.ok) {
      showOutput(`Error: ${data.error}`, true);
      return;
    }

    showOutput(
      `Published successfully!\n\n` +
      `Signature: ${data.signature}\n` +
      `Address: ${data.address}\n` +
      `Memo length: ${data.memoLength} chars\n\n` +
      `Explorer: ${data.explorerUrl}\n\n` +
      `Clients built with Solana mode and address "${data.address}" will now connect to:\n${serverUrl}`
    );

    walletInfo.classList.remove("hidden");
    walletAddress.textContent = `Address: ${data.address}`;
  } catch (err) {
    showOutput(`Error: ${err.message}`, true);
  } finally {
    publishBtn.disabled = false;
    publishBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Publish to Solana';
  }
});
