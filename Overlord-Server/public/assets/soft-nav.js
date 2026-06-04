let installedTracker = false;
let pageTrackingEnabled = false;
let navSeq = 0;

const tracked = {
  events: new Set(),
  intervals: new Set(),
  sockets: new Set(),
  workers: new Set(),
};

const original = {};
const loadedClassicScripts = new Set();
const persistentIds = new Set([
  "top-nav",
  "sb-mobile-bar",
  "sb-backdrop",
  "nav-reveal-btn",
  "chat-bubble",
  "chat-panel",
  "cert-trust-banner",
]);

function normalizeUrl(value, base = window.location.href) {
  try {
    return new URL(value, base).href;
  } catch {
    return value || "";
  }
}

function scriptPath(value) {
  try {
    return new URL(value, window.location.href).pathname;
  } catch {
    return "";
  }
}

function shouldSkipScript(script) {
  const path = scriptPath(script.getAttribute("src") || "");
  return path === "/assets/nav.js" || path === "/assets/nav-prelude.js";
}

function isPersistentNode(node) {
  return node instanceof Element && persistentIds.has(node.id);
}

function cleanupTrackedResources() {
  pageTrackingEnabled = false;
  window.dispatchEvent(new Event("pagehide"));

  for (const id of tracked.intervals) original.clearInterval(id);
  for (const entry of tracked.events) {
    original.removeEventListener.call(entry.target, entry.type, entry.listener, entry.options);
  }
  for (const socket of tracked.sockets) {
    try {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close(1000, "soft navigation");
    } catch {}
  }
  for (const worker of tracked.workers) {
    try {
      worker.terminate();
    } catch {}
  }

  tracked.events.clear();
  tracked.intervals.clear();
  tracked.sockets.clear();
  tracked.workers.clear();

  document.querySelectorAll("script[data-soft-nav-script]").forEach((script) => script.remove());
  document.getElementById("cmdp-root")?.remove();
  pageTrackingEnabled = true;
}

export function runWithoutPageTracking(fn) {
  const previous = pageTrackingEnabled;
  pageTrackingEnabled = false;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        pageTrackingEnabled = previous;
      });
    }
    pageTrackingEnabled = previous;
    return result;
  } catch (err) {
    pageTrackingEnabled = previous;
    throw err;
  }
}

export function startPageTracking() {
  pageTrackingEnabled = true;
}

export function installPageResourceTracker() {
  if (installedTracker) return;
  installedTracker = true;

  document.querySelectorAll("script[src]").forEach((script) => {
    const src = script.getAttribute("src");
    if (src && script.type !== "module") loadedClassicScripts.add(normalizeUrl(src));
  });

  original.addEventListener = EventTarget.prototype.addEventListener;
  original.removeEventListener = EventTarget.prototype.removeEventListener;
  original.setInterval = window.setInterval;
  original.clearInterval = window.clearInterval;
  original.WebSocket = window.WebSocket;
  original.Worker = window.Worker;

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (pageTrackingEnabled && listener) {
      tracked.events.add({ target: this, type, listener, options });
    }
    return original.addEventListener.call(this, type, listener, options);
  };

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    for (const entry of tracked.events) {
      if (entry.target === this && entry.type === type && entry.listener === listener) {
        tracked.events.delete(entry);
      }
    }
    return original.removeEventListener.call(this, type, listener, options);
  };

  window.setInterval = function (...args) {
    const id = original.setInterval.apply(window, args);
    if (pageTrackingEnabled) tracked.intervals.add(id);
    return id;
  };

  window.clearInterval = function (id) {
    tracked.intervals.delete(id);
    return original.clearInterval.call(window, id);
  };

  if (typeof original.WebSocket === "function") {
    window.WebSocket = function (...args) {
      const socket = new original.WebSocket(...args);
      if (pageTrackingEnabled) tracked.sockets.add(socket);
      return socket;
    };
    window.WebSocket.prototype = original.WebSocket.prototype;
    Object.defineProperty(window.WebSocket, "CONNECTING", { value: original.WebSocket.CONNECTING });
    Object.defineProperty(window.WebSocket, "OPEN", { value: original.WebSocket.OPEN });
    Object.defineProperty(window.WebSocket, "CLOSING", { value: original.WebSocket.CLOSING });
    Object.defineProperty(window.WebSocket, "CLOSED", { value: original.WebSocket.CLOSED });
  }

  if (typeof original.Worker === "function") {
    window.Worker = function (...args) {
      const worker = new original.Worker(...args);
      if (pageTrackingEnabled) tracked.workers.add(worker);
      return worker;
    };
    window.Worker.prototype = original.Worker.prototype;
  }
}

function mergeHead(nextDoc, baseUrl) {
  document.title = nextDoc.title || document.title;

  const currentHtmlClasses = Array.from(document.documentElement.classList).filter((name) => (
    name.startsWith("nav-pre") || name === "dark"
  ));
  document.documentElement.className = nextDoc.documentElement.className || "";
  currentHtmlClasses.forEach((name) => document.documentElement.classList.add(name));

  nextDoc.head.querySelectorAll("link").forEach((link) => {
    const href = link.getAttribute("href");
    const rel = link.getAttribute("rel") || "";
    if (!href) return;
    const normalized = normalizeUrl(href, baseUrl);
    const exists = Array.from(document.head.querySelectorAll("link")).some((existing) => (
      (existing.getAttribute("rel") || "") === rel
        && normalizeUrl(existing.getAttribute("href") || "") === normalized
    ));
    if (!exists) {
      const clone = link.cloneNode(true);
      clone.setAttribute("href", normalized);
      document.head.appendChild(clone);
    }
  });

  nextDoc.head.querySelectorAll("style").forEach((style) => {
    const text = style.textContent || "";
    const exists = Array.from(document.head.querySelectorAll("style[data-soft-nav-style]"))
      .some((existing) => existing.textContent === text);
    if (!exists) {
      const clone = style.cloneNode(true);
      clone.dataset.softNavStyle = "true";
      document.head.appendChild(clone);
    }
  });
}

function replaceBody(nextDoc) {
  const preserved = Array.from(document.body.children).filter(isPersistentNode);
  const nav = document.getElementById("top-nav");
  const anchor = document.getElementById("cert-trust-banner")
    || document.getElementById("sb-mobile-bar")
    || nav;
  const preservedClasses = Array.from(document.body.classList).filter((name) => (
    name.startsWith("sb-") || name === "nav-hidden"
  ));

  Array.from(document.body.children).forEach((node) => {
    if (!preserved.includes(node)) node.remove();
  });

  document.body.className = nextDoc.body.className || "";
  preservedClasses.forEach((name) => document.body.classList.add(name));

  let insertAfter = anchor;
  Array.from(nextDoc.body.children).forEach((node) => {
    if (node.matches?.("script") || node.id === "top-nav") return;
    const clone = document.importNode(node, true);
    if (insertAfter?.parentNode) {
      insertAfter.parentNode.insertBefore(clone, insertAfter.nextSibling);
      insertAfter = clone;
    } else {
      document.body.appendChild(clone);
      insertAfter = clone;
    }
  });
}

function appendScript(script, baseUrl) {
  if (shouldSkipScript(script)) return Promise.resolve();

  const src = script.getAttribute("src");
  const type = script.getAttribute("type") || "";
  if (src && type !== "module") {
    const normalized = normalizeUrl(src, baseUrl);
    if (loadedClassicScripts.has(normalized)) return Promise.resolve();
    loadedClassicScripts.add(normalized);
  }

  return new Promise((resolve, reject) => {
    const next = document.createElement("script");
    for (const { name, value } of script.attributes) {
      if (name !== "src") next.setAttribute(name, value);
    }
    next.dataset.softNavScript = "true";
    next.onload = () => resolve();
    next.onerror = () => reject(new Error(`Failed to load ${src || "inline script"}`));

    if (src) {
      const url = new URL(src, baseUrl);
      if (type === "module" && url.origin === window.location.origin) {
        url.searchParams.set("softNav", String(navSeq));
      }
      next.src = url.href;
    } else {
      next.textContent = script.textContent || "";
    }

    document.body.appendChild(next);
    if (!src) resolve();
  });
}

async function runPageScripts(nextDoc, baseUrl) {
  const scripts = Array.from(nextDoc.querySelectorAll("script"));
  for (const script of scripts) {
    await appendScript(script, baseUrl);
  }
}

function refreshGlobalEnhancements() {
  if (typeof window.addRippleEffect === "function") {
    document
      .querySelectorAll("button:not(.no-ripple), .button:not(.no-ripple)")
      .forEach((button) => window.addRippleEffect(button));
  }
}

function isSoftNavigationCandidate(url, link) {
  if (url.origin !== window.location.origin) return false;
  if (link?.target && link.target !== "_self") return false;
  if (link?.hasAttribute("download")) return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname.includes(".")) return false;
  if (url.pathname === window.location.pathname && url.search === window.location.search) return false;
  return true;
}

export function setupSoftNavigation(host, { onPathChange } = {}) {
  if (!host || host.dataset.softNavReady === "true") return;
  host.dataset.softNavReady = "true";

  async function navigateTo(href, { replace = false } = {}) {
    const url = new URL(href, window.location.href);
    if (!isSoftNavigationCandidate(url)) {
      window.location.href = url.href;
      return;
    }

    navSeq += 1;
    document.body.classList.add("soft-nav-loading");

    try {
      const res = await fetch(url.href, { credentials: "include" });
      if (!res.ok) throw new Error(`Navigation failed: ${res.status}`);
      const html = await res.text();
      const nextDoc = new DOMParser().parseFromString(html, "text/html");
      if (!nextDoc.getElementById("top-nav")) {
        window.location.href = url.href;
        return;
      }

      cleanupTrackedResources();
      mergeHead(nextDoc, url.href);
      replaceBody(nextDoc);
      window.scrollTo(0, 0);
      if (replace) history.replaceState({}, "", url.href);
      else history.pushState({}, "", url.href);
      onPathChange?.(url.pathname);
      await runPageScripts(nextDoc, url.href);
      refreshGlobalEnhancements();
      window.dispatchEvent(new CustomEvent("overlord:soft-nav", { detail: { path: url.pathname } }));
    } catch (err) {
      console.error("Soft navigation failed:", err);
      window.location.href = url.href;
    } finally {
      document.body.classList.remove("soft-nav-loading");
    }
  }

  host.addEventListener("click", (event) => {
    const link = event.target?.closest?.("a[href]");
    if (!link) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;

    const url = new URL(link.getAttribute("href"), window.location.href);
    if (!isSoftNavigationCandidate(url, link)) return;

    event.preventDefault();
    navigateTo(url.href);
  }, true);

  window.addEventListener("popstate", () => {
    navigateTo(window.location.href, { replace: true });
  });

  window.overlordSoftNavigate = navigateTo;
}
