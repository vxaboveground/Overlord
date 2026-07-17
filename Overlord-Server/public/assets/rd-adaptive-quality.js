const MIN_BITRATE_MBPS = 2;
const MAX_BITRATE_MBPS = 50;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeAdaptiveProfiles(profiles) {
  const seen = new Set();
  const normalized = [];
  for (const raw of Array.isArray(profiles) ? profiles : []) {
    const width = Math.max(0, Math.floor(Number(raw?.width) || 0));
    const height = Math.max(0, Math.floor(Number(raw?.height) || 0));
    const maxHeight = Math.floor(Number(raw?.maxHeight) || 0);
    const fps = Math.max(1, Math.min(240, Math.floor(Number(raw?.fps) || 0)));
    if (!height || !fps) continue;
    const key = `${width}x${height}@${fps}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ ...raw, width, height, maxHeight, fps });
  }
  normalized.sort((a, b) => {
    const pixelDelta = (b.width * b.height) - (a.width * a.height);
    if (pixelDelta) return pixelDelta;
    if (b.height !== a.height) return b.height - a.height;
    return b.fps - a.fps;
  });
  return normalized;
}

export function automaticBitrateMbps(profile) {
  const pixelsPerSecond = Math.max(1, Number(profile?.width) || 0) *
    Math.max(1, Number(profile?.height) || 0) *
    Math.max(1, Number(profile?.fps) || 60);
  return Math.max(MIN_BITRATE_MBPS, Math.min(18, Math.ceil((pixelsPerSecond * 0.08) / 1_000_000)));
}

export class AdaptiveDesktopQuality {
  constructor(onTarget, options = {}) {
    this.onTarget = typeof onTarget === "function" ? onTarget : () => {};
    this.cooldownMs = Number(options.cooldownMs) || 5000;
    this.badSamplesRequired = Number(options.badSamplesRequired) || 2;
    this.strainedSamplesRequired = Number(options.strainedSamplesRequired) || 3;
    this.stableSamplesRequired = Number(options.stableSamplesRequired) || 10;
    this.profiles = [];
    this.enabled = false;
    this.profileIndex = 0;
    this.targetBitrateMbps = 0;
    this.badSamples = 0;
    this.strainedSamples = 0;
    this.stableSamples = 0;
    this.bitrateReductionsAtProfile = 0;
    this.lastChangeAt = Number.NEGATIVE_INFINITY;
    this.lastReason = "";
  }

  setProfiles(profiles) {
    this.profiles = normalizeAdaptiveProfiles(profiles);
    this.resetState();
    return this.profiles;
  }

  start(now = 0) {
    this.enabled = this.profiles.length > 0;
    this.resetState();
    if (!this.enabled) return null;
    this.lastChangeAt = now;
    return this.emit("Auto started at best profile");
  }

  stop() {
    this.enabled = false;
    this.resetCounters();
  }

  current() {
    const profile = this.profiles[this.profileIndex] || null;
    if (!profile) return null;
    return {
      profile,
      profileIndex: this.profileIndex,
      profileCount: this.profiles.length,
      bitrateMbps: this.targetBitrateMbps || automaticBitrateMbps(profile),
      reason: this.lastReason,
    };
  }

  sample(stats, agentStats, now = Date.now()) {
    if (!this.enabled || !this.profiles.length) return null;
    const media = stats?.video;
    if (!media) return null;

    const loss = finite(media.lossPercent) ?? 0;
    const rtt = finite(stats?.rttMs);
    const jitter = finite(media.jitterMs);
    const jitterBuffer = finite(media.jitterBufferMs);
    const dropped = finite(media.framesDroppedDelta) ?? 0;
    const viewerFps = finite(media.framesPerSecond);
    const agentFps = finite(agentStats?.fps);
    const available = finite(stats?.availableIncomingMbps);
    const fpsRatio = viewerFps != null && agentFps != null && agentFps > 0 ? viewerFps / agentFps : null;
    const capacityTight = available != null && available > 0 && this.targetBitrateMbps > available * 0.9;

    const bad = loss >= 5 || (rtt != null && rtt >= 250) ||
      (jitterBuffer != null && jitterBuffer >= 80) || dropped >= 3 ||
      (fpsRatio != null && fpsRatio < 0.75) || (capacityTight && available < this.targetBitrateMbps * 0.7);
    const strained = !bad && (loss >= 2 || (rtt != null && rtt >= 160) ||
      (jitter != null && jitter >= 35) || (jitterBuffer != null && jitterBuffer >= 40) ||
      dropped > 0 || (fpsRatio != null && fpsRatio < 0.9) || capacityTight);
    const stable = !bad && !strained && loss < 1 && dropped === 0 &&
      (rtt == null || rtt < 120) && (jitterBuffer == null || jitterBuffer < 25) &&
      (fpsRatio == null || fpsRatio >= 0.95);

    this.badSamples = bad ? this.badSamples + 1 : 0;
    this.strainedSamples = strained ? this.strainedSamples + 1 : 0;
    this.stableSamples = stable ? this.stableSamples + 1 : 0;
    if (now - this.lastChangeAt < this.cooldownMs) return null;

    if (this.badSamples >= this.badSamplesRequired) {
      return this.reduce("Severe WebRTC congestion", now, 0.72);
    }
    if (this.strainedSamples >= this.strainedSamplesRequired) {
      return this.reduce("Sustained WebRTC congestion", now, 0.84);
    }
    if (this.stableSamples >= this.stableSamplesRequired) {
      return this.increase("WebRTC connection stable", now);
    }
    return null;
  }

  resetState() {
    this.profileIndex = 0;
    this.targetBitrateMbps = this.profiles[0] ? automaticBitrateMbps(this.profiles[0]) : 0;
    this.bitrateReductionsAtProfile = 0;
    this.lastReason = "";
    this.resetCounters();
  }

  resetCounters() {
    this.badSamples = 0;
    this.strainedSamples = 0;
    this.stableSamples = 0;
  }

  reduce(reason, now, factor) {
    const profile = this.profiles[this.profileIndex];
    const floor = Math.max(MIN_BITRATE_MBPS, Math.ceil(automaticBitrateMbps(profile) * 0.45));
    const reduced = Math.max(floor, Math.floor(this.targetBitrateMbps * factor));
    if (reduced < this.targetBitrateMbps && this.bitrateReductionsAtProfile < 1) {
      this.targetBitrateMbps = reduced;
      this.bitrateReductionsAtProfile += 1;
    } else if (this.profileIndex < this.profiles.length - 1) {
      this.profileIndex += 1;
      this.bitrateReductionsAtProfile = 0;
      this.targetBitrateMbps = Math.min(
        Math.max(MIN_BITRATE_MBPS, this.targetBitrateMbps),
        automaticBitrateMbps(this.profiles[this.profileIndex]),
      );
    } else if (reduced < this.targetBitrateMbps) {
      this.targetBitrateMbps = reduced;
    } else {
      this.resetCounters();
      return null;
    }
    this.lastChangeAt = now;
    this.resetCounters();
    return this.emit(reason);
  }

  increase(reason, now) {
    const nominal = automaticBitrateMbps(this.profiles[this.profileIndex]);
    if (this.targetBitrateMbps < nominal) {
      this.targetBitrateMbps = Math.min(nominal, Math.max(this.targetBitrateMbps + 1, Math.ceil(this.targetBitrateMbps * 1.12)));
    } else if (this.profileIndex > 0) {
      this.profileIndex -= 1;
      this.bitrateReductionsAtProfile = 0;
      this.targetBitrateMbps = Math.min(this.targetBitrateMbps, automaticBitrateMbps(this.profiles[this.profileIndex]));
    } else {
      this.resetCounters();
      return null;
    }
    this.lastChangeAt = now;
    this.resetCounters();
    return this.emit(reason);
  }

  emit(reason) {
    this.lastReason = reason;
    const current = this.current();
    if (!current) return null;
    const target = {
      maxHeight: current.profile.maxHeight,
      fps: current.profile.fps,
      width: current.profile.width,
      height: current.profile.height,
      bitrateMbps: Math.max(MIN_BITRATE_MBPS, Math.min(MAX_BITRATE_MBPS, Math.round(current.bitrateMbps))),
      profileIndex: current.profileIndex,
      profileCount: current.profileCount,
      reason,
    };
    this.onTarget(target);
    return target;
  }
}
