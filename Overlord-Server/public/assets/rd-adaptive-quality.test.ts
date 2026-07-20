import { describe, expect, test } from "bun:test";
import { AdaptiveDesktopQuality, automaticBitrateMbps, normalizeAdaptiveProfiles } from "./rd-adaptive-quality.js";

const profiles = [
  { maxHeight: 720, width: 1280, height: 720, fps: 60 },
  { maxHeight: 1080, width: 1920, height: 1080, fps: 60 },
  { maxHeight: -1, width: 2560, height: 1440, fps: 144 },
];

describe("adaptive remote desktop quality", () => {
  test("ranks native resolution first and starts at the best profile", () => {
    const ranked = normalizeAdaptiveProfiles(profiles);
    expect(ranked.map((profile) => profile.height)).toEqual([1440, 1080, 720]);
    const targets: any[] = [];
    const controller = new AdaptiveDesktopQuality((target) => targets.push(target));
    controller.setProfiles(profiles);
    controller.start(0);
    expect(targets[0].height).toBe(1440);
    expect(targets[0].fps).toBe(144);
    expect(targets[0].bitrateMbps).toBe(automaticBitrateMbps(ranked[0]));
  });

  test("requires sustained congestion before reducing bitrate and then profile", () => {
    const targets: any[] = [];
    const controller = new AdaptiveDesktopQuality((target) => targets.push(target), { cooldownMs: 1 });
    controller.setProfiles(profiles);
    controller.start(0);
    const bad = { rttMs: 300, video: { lossPercent: 7, framesDroppedDelta: 4, framesPerSecond: 40 } };
    expect(controller.sample(bad, { fps: 144 }, 10)).toBeNull();
    expect(controller.sample(bad, { fps: 144 }, 11)?.height).toBe(1440);
    expect(controller.sample(bad, { fps: 144 }, 20)).toBeNull();
    expect(controller.sample(bad, { fps: 144 }, 21)?.height).toBe(1080);
  });

  test("slowly recovers after stable feedback", () => {
    const controller = new AdaptiveDesktopQuality(() => {}, {
      cooldownMs: 1,
      badSamplesRequired: 1,
      stableSamplesRequired: 2,
    });
    controller.setProfiles(profiles);
    controller.start(0);
    const bad = { rttMs: 300, video: { lossPercent: 8, framesDroppedDelta: 5, framesPerSecond: 20 } };
    controller.sample(bad, { fps: 144 }, 2);
    controller.sample(bad, { fps: 144 }, 4);
    expect(controller.current()?.profile.height).toBe(1080);
    const stable = { rttMs: 30, video: { lossPercent: 0, framesDroppedDelta: 0, framesPerSecond: 60, jitterBufferMs: 5 } };
    expect(controller.sample(stable, { fps: 60 }, 6)).toBeNull();
    const recovered = controller.sample(stable, { fps: 60 }, 7);
    expect(recovered?.height).toBe(1440);
  });

  test("does not reduce quality for browser jitter buffer alone", () => {
    const targets = [];
    const controller = new AdaptiveDesktopQuality((target) => targets.push(target), {
      cooldownMs: 1,
      badSamplesRequired: 1,
      strainedSamplesRequired: 1,
    });
    controller.setProfiles(profiles);
    controller.start(0);
    const healthyBuffered = {
      rttMs: 1,
      video: {
        lossPercent: 0,
        jitterMs: 2,
        jitterBufferMs: 120,
        framesDroppedDelta: 0,
        framesPerSecond: 60,
      },
    };

    expect(controller.sample(healthyBuffered, { fps: 60 }, 2)).toBeNull();
    expect(controller.current()?.profile.height).toBe(1440);
    expect(targets).toHaveLength(1);
  });
});
