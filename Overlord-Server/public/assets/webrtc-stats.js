// Shared receiver-side WebRTC telemetry for P2P and WHEP sessions.
// Values are deliberately normalized here so the viewer pages do not need to
// know about browser-specific RTCStatsReport relationships.
export class WebRTCStatsSampler {
  constructor(pc, onStats, intervalMs = 1000) {
    this.pc = pc;
    this.onStats = typeof onStats === "function" ? onStats : () => {};
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
    this.previous = new Map();
  }

  start() {
    if (this.timer || !this.pc) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    this.previous.clear();
  }

  async sample() {
    if (this.running || !this.pc || this.pc.connectionState === "closed") return;
    this.running = true;
    try {
      const report = await this.pc.getStats();
      const byId = new Map();
      report.forEach((item) => byId.set(item.id, item));

      const result = {
        timestamp: performance.now(),
        rttMs: null,
        availableIncomingMbps: null,
        protocol: "",
        route: "",
        video: null,
        audio: null,
      };

      let selectedPair = null;
      for (const item of byId.values()) {
        if (item.type === "transport" && item.selectedCandidatePairId) {
          selectedPair = byId.get(item.selectedCandidatePairId) || selectedPair;
        }
        if (item.type === "candidate-pair" && item.state === "succeeded" && (item.nominated || item.selected)) {
          selectedPair = selectedPair || item;
        }
      }
      if (selectedPair) {
        if (Number.isFinite(selectedPair.currentRoundTripTime)) {
          result.rttMs = selectedPair.currentRoundTripTime * 1000;
        }
        if (Number.isFinite(selectedPair.availableIncomingBitrate)) {
          result.availableIncomingMbps = selectedPair.availableIncomingBitrate / 1_000_000;
        }
        const local = byId.get(selectedPair.localCandidateId);
        const remote = byId.get(selectedPair.remoteCandidateId);
        result.protocol = String(local?.protocol || remote?.protocol || "").toUpperCase();
        result.route = summarizeRoute(local?.candidateType, remote?.candidateType);
      }

      for (const item of byId.values()) {
        if (item.type !== "inbound-rtp" || item.isRemote) continue;
        const kind = item.kind || item.mediaType;
        if (kind !== "video" && kind !== "audio") continue;
        const codec = byId.get(item.codecId);
        const previous = this.previous.get(item.id);
        const timestamp = Number(item.timestamp) || performance.now();
        let bitrateMbps = null;
        let decodeMs = null;
        let processingDelayMs = null;
        let framesDroppedDelta = null;
        let intervalLossPercent = null;
        let intervalJitterBufferMs = null;
        if (previous && timestamp > previous.timestamp && Number(item.bytesReceived) >= previous.bytesReceived) {
          bitrateMbps = ((Number(item.bytesReceived) - previous.bytesReceived) * 8) /
            ((timestamp - previous.timestamp) * 1000);
          const decodedDelta = (Number(item.framesDecoded) || 0) - previous.framesDecoded;
          if (decodedDelta > 0) {
            const decodeDelta = (Number(item.totalDecodeTime) || 0) - previous.totalDecodeTime;
            const processingDelta = (Number(item.totalProcessingDelay) || 0) - previous.totalProcessingDelay;
            if (decodeDelta >= 0) decodeMs = (decodeDelta * 1000) / decodedDelta;
            if (processingDelta >= 0) processingDelayMs = (processingDelta * 1000) / decodedDelta;
          }
          const droppedDelta = (Number(item.framesDropped) || 0) - previous.framesDropped;
          if (droppedDelta >= 0) framesDroppedDelta = droppedDelta;
          const receivedDelta = (Number(item.packetsReceived) || 0) - previous.packetsReceived;
          const lostDelta = (Number(item.packetsLost) || 0) - previous.packetsLost;
          const packetDelta = Math.max(0, receivedDelta) + Math.max(0, lostDelta);
          if (packetDelta > 0) intervalLossPercent = (Math.max(0, lostDelta) * 100) / packetDelta;
          const jitterBufferDelayDelta = (Number(item.jitterBufferDelay) || 0) - previous.jitterBufferDelay;
          const jitterBufferEmittedDelta = (Number(item.jitterBufferEmittedCount) || 0) - previous.jitterBufferEmittedCount;
          if (jitterBufferDelayDelta >= 0 && jitterBufferEmittedDelta > 0) {
            intervalJitterBufferMs = (jitterBufferDelayDelta * 1000) / jitterBufferEmittedDelta;
          }
        }
        this.previous.set(item.id, {
          timestamp,
          bytesReceived: Number(item.bytesReceived) || 0,
          framesDecoded: Number(item.framesDecoded) || 0,
          totalDecodeTime: Number(item.totalDecodeTime) || 0,
          totalProcessingDelay: Number(item.totalProcessingDelay) || 0,
          framesDropped: Number(item.framesDropped) || 0,
          packetsReceived: Number(item.packetsReceived) || 0,
          packetsLost: Number(item.packetsLost) || 0,
          jitterBufferDelay: Number(item.jitterBufferDelay) || 0,
          jitterBufferEmittedCount: Number(item.jitterBufferEmittedCount) || 0,
        });
        const packetsReceived = Number(item.packetsReceived) || 0;
        const packetsLost = Math.max(0, Number(item.packetsLost) || 0);
        const packetTotal = packetsReceived + packetsLost;
        result[kind] = {
          bitrateMbps,
          packetsLost,
          lossPercent: intervalLossPercent ?? (packetTotal > 0 ? (packetsLost * 100) / packetTotal : 0),
          jitterMs: Number.isFinite(item.jitter) ? item.jitter * 1000 : null,
          jitterBufferMs: intervalJitterBufferMs ?? averageJitterBufferMs(item),
          decodeMs,
          processingDelayMs,
          framesDropped: Number.isFinite(item.framesDropped) ? item.framesDropped : null,
          framesDroppedDelta,
          framesPerSecond: Number.isFinite(item.framesPerSecond) ? item.framesPerSecond : null,
          width: Number.isFinite(item.frameWidth) ? item.frameWidth : null,
          height: Number.isFinite(item.frameHeight) ? item.frameHeight : null,
          codec: String(codec?.mimeType || "").replace(/^\w+\//, ""),
        };
      }
      this.onStats(result);
    } catch (error) {
      if (this.pc?.connectionState !== "closed") console.debug("webrtc stats unavailable", error);
    } finally {
      this.running = false;
    }
  }
}

function averageJitterBufferMs(item) {
  const delay = Number(item.jitterBufferDelay);
  const emitted = Number(item.jitterBufferEmittedCount);
  return Number.isFinite(delay) && emitted > 0 ? (delay * 1000) / emitted : null;
}

function summarizeRoute(localType, remoteType) {
  const types = [localType, remoteType].filter(Boolean);
  if (types.includes("relay")) return "Relay";
  if (types.includes("srflx") || types.includes("prflx")) return "P2P";
  if (types.includes("host")) return "Direct";
  return "";
}
