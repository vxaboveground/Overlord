// Tiny WHEP (WebRTC-HTTP Egress Protocol) client.
//
// Wires a <video> element to a server-proxied WHEP endpoint:
//   1. Create a recvonly video PeerConnection.
//   2. POST our SDP offer to whepPath, parse the SDP answer.
//   3. ontrack → attach MediaStream to the <video>.
//
// The Bun server proxies all signaling to MediaMTX, so this fetch inherits the
// existing JWT cookie. ICE/DTLS go straight to MediaMTX over UDP.

export class WhepClient {
  /**
   * @param {object} opts
   * @param {string} opts.whepPath  Path under the same origin, e.g. "/api/webrtc/agents/abc/desktop/whep"
   * @param {HTMLVideoElement} [opts.videoEl]  Attach the video track here.
   * @param {HTMLAudioElement} [opts.audioEl]  Attach the audio track here.
   *                                            Default: hidden <audio> appended to <body>.
   * @param {(state: string) => void} [opts.onState]
   */
  constructor(opts) {
    this.whepPath = opts.whepPath;
    this.videoEl = opts.videoEl || null;
    this.audioEl = opts.audioEl || null;
    this.onState = opts.onState || (() => {});
    this.pc = null;
    this.resourceURL = "";
  }

  async start() {
    if (this.pc) await this.stop();

    const pc = new RTCPeerConnection({});
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
    pc.onconnectionstatechange = () => {
      this.onState(pc.connectionState);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc, 5000);

    // The agent's WHIP publish and the operator's WHEP play start in parallel
    // when "Start" is clicked. If the operator's WHEP arrives at MediaMTX
    // before the agent's publish finishes setting up, MediaMTX returns 404
    // "no stream is available on path ...". Retry briefly to absorb that
    // race instead of immediately failing back to canvas.
    const resp = await fetchWithRetry(this.whepPath, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      credentials: "include",
      body: pc.localDescription.sdp,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`WHEP ${resp.status}: ${text || resp.statusText}`);
    }
    this.resourceURL = resp.headers.get("Location") || "";
    const answerSDP = await resp.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSDP });
  }

  async stop() {
    const pc = this.pc;
    const url = this.resourceURL;
    this.pc = null;
    this.resourceURL = "";
    if (url) {
      try {
        await fetch(url, { method: "DELETE", credentials: "include" });
      } catch {}
    }
    if (pc) {
      try { pc.close(); } catch {}
    }
    if (this.videoEl) this.videoEl.srcObject = null;
    if (this.audioEl) this.audioEl.srcObject = null;
  }
}

async function fetchWithRetry(url, init, { attempts = 12, delayMs = 400 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await fetch(url, init);
    // Only retry the specific "publisher not yet ready" 404 from MediaMTX.
    // Anything else (auth, network) should fail fast.
    if (last.status !== 404) return last;
    const text = await last.clone().text().catch(() => "");
    if (!/no stream is available/i.test(text)) return last;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

function waitIceComplete(pc, timeoutMs) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(finish, timeoutMs);
  });
}
