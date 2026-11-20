/** Brute-force guard for the one password: MAX_FAILURES wrong tries lock login for LOCKOUT_MS. */
export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 60_000;

export class LoginLimiter {
  private failures = 0;
  private lockedUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds left on the lockout, or 0 if login is allowed. */
  lockedForMs(): number {
    return Math.max(0, this.lockedUntil - this.now());
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= MAX_FAILURES) {
      this.lockedUntil = this.now() + LOCKOUT_MS;
      this.failures = 0;
    }
  }

  recordSuccess(): void {
    this.failures = 0;
  }
}
