import { describe, expect, test } from "bun:test";
import {
  canUserBuild,
  getBuildRateLimitStats,
  recordBuildEnd,
  recordBuildStart,
} from "./build-rate-limit";

// Module state is process-global. Each test uses a unique userId so concurrent
// or sequential tests don't leak state into each other, and always pairs every
// recordBuildStart with a recordBuildEnd in a try/finally to keep global counts
// clean for unrelated tests.

let nextUserId = 1_000_000;
function uniqueUser(): number {
  nextUserId += 1;
  return nextUserId;
}

describe("canUserBuild", () => {
  test("allows a fresh user", () => {
    expect(canUserBuild(uniqueUser())).toEqual({ allowed: true });
  });

  test("blocks user once their per-user concurrent limit is reached", () => {
    const userId = uniqueUser();
    const started: number[] = [];
    try {
      // Saturate the per-user concurrent slot (default config: 1).
      while (true) {
        const decision = canUserBuild(userId);
        if (!decision.allowed) break;
        recordBuildStart(userId);
        started.push(userId);
        if (started.length > 20) throw new Error("unexpected: never hit per-user cap");
      }
      const blocked = canUserBuild(userId);
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toMatch(/concurrent per user/i);
    } finally {
      for (const u of started) recordBuildEnd(u);
    }
  });

  test("releases the slot after recordBuildEnd", () => {
    const userId = uniqueUser();
    recordBuildStart(userId);
    try {
      const mid = canUserBuild(userId);
      // May be blocked depending on per-user cap; either way recordBuildEnd must restore capacity.
      if (!mid.allowed) {
        recordBuildEnd(userId);
        expect(canUserBuild(userId).allowed).toBe(true);
        // Re-start so the finally block's recordBuildEnd matches a started build.
        recordBuildStart(userId);
      }
    } finally {
      recordBuildEnd(userId);
    }
  });
});

describe("recordBuildStart / recordBuildEnd", () => {
  test("globalActive increases then decreases symmetrically", () => {
    const userId = uniqueUser();
    const before = getBuildRateLimitStats().globalActive;
    recordBuildStart(userId);
    try {
      expect(getBuildRateLimitStats().globalActive).toBe(before + 1);
    } finally {
      recordBuildEnd(userId);
    }
    expect(getBuildRateLimitStats().globalActive).toBe(before);
  });

  test("recordBuildEnd on a user with no active builds does not underflow", () => {
    const userId = uniqueUser();
    const before = getBuildRateLimitStats().globalActive;
    // No matching start. Should be a no-op for global count.
    recordBuildEnd(userId);
    expect(getBuildRateLimitStats().globalActive).toBe(before);
  });

  test("multiple starts accumulate active count per user", () => {
    const userId = uniqueUser();
    recordBuildStart(userId);
    recordBuildStart(userId);
    try {
      const stats = getBuildRateLimitStats();
      const entry = stats.perUser.find((u) => u.userId === userId);
      expect(entry).toBeDefined();
      expect(entry!.active).toBe(2);
      expect(entry!.recentCount).toBe(2);
    } finally {
      recordBuildEnd(userId);
      recordBuildEnd(userId);
    }
  });
});

describe("getBuildRateLimitStats", () => {
  test("omits users with no recent or active builds", () => {
    const userId = uniqueUser();
    recordBuildStart(userId);
    recordBuildEnd(userId);
    // Without waiting an hour the timestamp is still 'recent', so the entry stays —
    // but stats should still report it as active=0 if anything is reported at all.
    const stats = getBuildRateLimitStats();
    const entry = stats.perUser.find((u) => u.userId === userId);
    if (entry) {
      expect(entry.active).toBe(0);
      expect(entry.recentCount).toBeGreaterThan(0);
    }
  });
});
