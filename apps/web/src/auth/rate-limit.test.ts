import { describe, expect, it } from "vitest";
import { LOCKOUT_MS, LoginLimiter, MAX_FAILURES } from "./rate-limit.js";

describe("LoginLimiter", () => {
  it("allows attempts until MAX_FAILURES wrong passwords, then locks", () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect(limiter.lockedForMs()).toBe(0);
      limiter.recordFailure();
    }
    expect(limiter.lockedForMs()).toBe(LOCKOUT_MS);
    now += 1000;
    expect(limiter.lockedForMs()).toBe(LOCKOUT_MS - 1000);
  });

  it("unlocks after the lockout and starts counting again", () => {
    let now = 0;
    const limiter = new LoginLimiter(() => now);
    for (let i = 0; i < MAX_FAILURES; i++) limiter.recordFailure();
    now += LOCKOUT_MS;
    expect(limiter.lockedForMs()).toBe(0);
    limiter.recordFailure();
    expect(limiter.lockedForMs()).toBe(0);
  });

  it("resets the count on a successful login", () => {
    const limiter = new LoginLimiter(() => 0);
    for (let i = 0; i < MAX_FAILURES - 1; i++) limiter.recordFailure();
    limiter.recordSuccess();
    limiter.recordFailure();
    expect(limiter.lockedForMs()).toBe(0);
  });
});
