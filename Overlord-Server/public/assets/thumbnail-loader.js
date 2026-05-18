const DEFAULT_CONCURRENCY = 6;
const DEFAULT_REFRESH_MS = 30_000;
const DEFAULT_VISIBILITY_THRESHOLD = 0.1;
const DEFAULT_ROOT_MARGIN = "200px";

const sharedInflight = { count: 0 };
const sharedQueue = [];
let sharedConcurrency = DEFAULT_CONCURRENCY;

function pumpQueue() {
  while (sharedInflight.count < sharedConcurrency && sharedQueue.length > 0) {
    const job = sharedQueue.shift();
    sharedInflight.count++;
    Promise.resolve()
      .then(() => job())
      .catch((err) => console.warn("[thumb] job failed", err))
      .finally(() => {
        sharedInflight.count--;
        pumpQueue();
      });
  }
}

function enqueueJob(job) {
  sharedQueue.push(job);
  pumpQueue();
}

export function setGlobalConcurrency(n) {
  sharedConcurrency = Math.max(1, Math.min(32, Number(n) || DEFAULT_CONCURRENCY));
  pumpQueue();
}

async function triggerAgentThumbnail(clientId) {
  try {
    const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}/thumbnail`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch (err) {
    return null;
  }
}

function buildThumbnailUrl(clientId, version) {
  const base = `/api/clients/${encodeURIComponent(clientId)}/thumbnail`;
  return version > 0 ? `${base}?v=${version}` : base;
}

export class ThumbnailLoader {
  constructor(options = {}) {
    this.refreshIntervalMs = Math.max(500, Number(options.refreshIntervalMs) || DEFAULT_REFRESH_MS);
    this.rootMargin = options.rootMargin || DEFAULT_ROOT_MARGIN;
    this.threshold = options.threshold ?? DEFAULT_VISIBILITY_THRESHOLD;
    this.onFrame = typeof options.onFrame === "function" ? options.onFrame : null;
    this.onError = typeof options.onError === "function" ? options.onError : null;
    this.onTrigger = typeof options.onTrigger === "function" ? options.onTrigger : null;
    this.records = new Map();
    this.tickTimer = null;
    this.observer = null;
    if (typeof IntersectionObserver === "function") {
      this.observer = new IntersectionObserver(
        (entries) => this.handleIntersection(entries),
        { rootMargin: this.rootMargin, threshold: this.threshold },
      );
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.tick();
    });
  }

  setRefreshInterval(ms) {
    const next = Math.max(500, Number(ms) || DEFAULT_REFRESH_MS);
    if (next === this.refreshIntervalMs) return;
    this.refreshIntervalMs = next;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = setInterval(() => this.tick(), Math.min(2000, Math.max(500, next / 4)));
    }
  }

  observe(element, clientId, initialVersion = 0) {
    if (!element || !clientId) return;
    const prior = this.records.get(element);
    if (prior && prior.clientId === clientId) {
      prior.version = initialVersion || prior.version;
      this.applyVersion(element, prior);
      return;
    }
    if (prior) this.unobserve(prior.element);
    const rec = {
      element,
      clientId,
      version: initialVersion || 0,
      visible: false,
      lastTriggerAt: 0,
      inflight: false,
    };
    this.records.set(element, rec);
    this.applyVersion(element, rec);
    if (this.observer) {
      this.observer.observe(element);
    } else {
      rec.visible = true;
    }
    this.ensureLoop();
  }

  unobserve(element) {
    if (!element) return;
    const rec = this.records.get(element);
    if (!rec) return;
    this.records.delete(element);
    if (this.observer) this.observer.unobserve(element);
    if (this.records.size === 0 && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  setVersion(clientId, version) {
    if (!clientId) return;
    let touched = false;
    for (const rec of this.records.values()) {
      if (rec.clientId !== clientId) continue;
      if (version > rec.version) {
        rec.version = version;
        this.applyVersion(rec.element, rec);
        touched = true;
      }
    }
    return touched;
  }

  refreshNow(clientId) {
    for (const rec of this.records.values()) {
      if (clientId && rec.clientId !== clientId) continue;
      rec.lastTriggerAt = 0;
    }
    this.tick();
  }

  applyVersion(element, rec) {
    if (!element || !rec) return;
    const img = element.querySelector("img[data-thumb-img]");
    if (!img) return;
    const url = buildThumbnailUrl(rec.clientId, rec.version);
    if (img.dataset.thumbUrl !== url) {
      img.dataset.thumbUrl = url;
      img.src = url;
    }
  }

  handleIntersection(entries) {
    for (const entry of entries) {
      const rec = this.records.get(entry.target);
      if (!rec) continue;
      rec.visible = entry.isIntersecting;
    }
    this.tick();
  }

  ensureLoop() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(
      () => this.tick(),
      Math.min(2000, Math.max(500, this.refreshIntervalMs / 4)),
    );
  }

  tick() {
    if (document.hidden) return;
    const now = Date.now();
    for (const rec of this.records.values()) {
      if (!rec.visible || rec.inflight) continue;
      if (now - rec.lastTriggerAt < this.refreshIntervalMs) continue;
      rec.lastTriggerAt = now;
      rec.inflight = true;
      if (this.onTrigger) {
        try { this.onTrigger(rec.clientId, rec.element); } catch {}
      }
      enqueueJob(async () => {
        try {
          const result = await triggerAgentThumbnail(rec.clientId);
          if (result && typeof result.version === "number" && result.version > rec.version) {
            rec.version = result.version;
            this.applyVersion(rec.element, rec);
            if (this.onFrame) {
              try { this.onFrame(rec.clientId, rec.element, result); } catch {}
            }
          }
        } catch (err) {
          if (this.onError) {
            try { this.onError(rec.clientId, err); } catch {}
          }
        } finally {
          rec.inflight = false;
        }
      });
    }
  }

  destroy() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.records.clear();
  }
}

export function thumbnailUrl(clientId, version = 0) {
  return buildThumbnailUrl(clientId, version);
}
