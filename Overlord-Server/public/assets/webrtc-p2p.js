// Browser ↔ agent direct WebRTC peer client.
//
// Signaling is multiplexed onto the existing Remote Desktop WS:
//   browser → server: { type: "webrtc_p2p_offer", sdp }
//                     { type: "webrtc_p2p_ice",   candidate, sdpMid, sdpMLineIndex }
//                     { type: "webrtc_p2p_stop" }
//   server → browser: { type: "webrtc_p2p_answer", sdp }
//                     { type: "webrtc_p2p_ice", ... }
//
// The server proxies these to the agent via its existing WS command channel
// (sessionId is server-side state, not visible to the browser).
//
// Once SDP + ICE settle, the <video> element receives frames directly from
// the agent — MediaMTX is not involved.

export class P2PClient {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} [opts.videoEl]
   * @param {HTMLAudioElement} [opts.audioEl]
   * @param {(msg: object) => void} opts.send  Send a JSON-encodable msg over the viewer's WS.
   * @param {(state: string) => void} [opts.onState]
   * @param {string[]} [opts.iceServers]  STUN URLs. Default: Google public STUN.
   */
  constructor(opts) {
    this.videoEl = opts.videoEl || null;
    this.audioEl = opts.audioEl || null;
    this.send = opts.send;
    this.onState = opts.onState || (() => {});
    this.iceServers = opts.iceServers || ["stun:stun.l.google.com:19302"];
    this.pc = null;
    this.pendingRemoteCandidates = [];
  }

  async start() {
    if (this.pc) await this.stop();

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers.map((u) => ({ urls: u })),
    });
    this.pc = pc;

    if (this.videoEl) pc.addTransceiver("video", { direction: "recvonly" });
    if (this.audioEl) pc.addTransceiver("audio", { direction: "recvonly" });

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] || new MediaStream([ev.track]);
      if (ev.track.kind === "video" && this.videoEl) {
        this.videoEl.srcObject = stream;
        this.videoEl.play().catch(() => {});
      } else if (ev.track.kind === "audio" && this.audioEl) {
        this.audioEl.srcObject = stream;
        this.audioEl.play().catch(() => {});
      }
    };
    pc.onicecandidate = (ev) => {
      // Trickle ICE: empty candidate signals end-of-gathering — we don't
      // forward it (Pion infers it on its own).
      if (!ev.candidate || !ev.candidate.candidate) return;
      this.send({
        type: "webrtc_p2p_ice",
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid || "",
        sdpMLineIndex: ev.candidate.sdpMLineIndex || 0,
      });
    };
    pc.onconnectionstatechange = () => {
      this.onState(pc.connectionState);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({ type: "webrtc_p2p_offer", sdp: pc.localDescription.sdp });
  }

  /** Handle an SDP answer relayed from the agent. */
  async onAnswer(sdp) {
    if (!this.pc || !sdp) return;
    await this.pc.setRemoteDescription({ type: "answer", sdp });
    // Drain any ICE candidates that arrived before the answer.
    const drain = this.pendingRemoteCandidates;
    this.pendingRemoteCandidates = [];
    for (const c of drain) {
      try { await this.pc.addIceCandidate(c); } catch (e) { console.warn("p2p: queued ice add failed", e); }
    }
  }

  /** Add a remote ICE candidate from the agent. */
  async onRemoteCandidate(msg) {
    if (!this.pc) return;
    if (!msg || typeof msg.candidate !== "string" || !msg.candidate) return;
    const init = {
      candidate: msg.candidate,
      sdpMid: typeof msg.sdpMid === "string" ? msg.sdpMid : null,
      sdpMLineIndex: Number.isInteger(msg.sdpMLineIndex) ? msg.sdpMLineIndex : null,
    };
    // If remote description hasn't been set yet, queue.
    if (!this.pc.remoteDescription) {
      this.pendingRemoteCandidates.push(init);
      return;
    }
    try { await this.pc.addIceCandidate(init); } catch (e) { console.warn("p2p: ice add failed", e); }
  }

  async stop() {
    const pc = this.pc;
    this.pc = null;
    this.pendingRemoteCandidates = [];
    if (pc) {
      try { pc.close(); } catch {}
    }
    try { this.send({ type: "webrtc_p2p_stop" }); } catch {}
    if (this.videoEl) this.videoEl.srcObject = null;
    if (this.audioEl) this.audioEl.srcObject = null;
  }
}
