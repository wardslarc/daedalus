/** In-memory sessions. Only a SHA-256 of each token is kept; a restart logs everyone out. */
import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "dae_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

export class SessionStore {
  private readonly expiries = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  create(): string {
    const token = randomBytes(32).toString("hex");
    this.expiries.set(digest(token), this.now() + SESSION_TTL_MS);
    return token;
  }

  isValid(token: string | undefined): boolean {
    if (!token) return false;
    const key = digest(token);
    const expires = this.expiries.get(key);
    if (expires === undefined) return false;
    if (this.now() >= expires) {
      this.expiries.delete(key);
      return false;
    }
    return true;
  }

  revoke(token: string | undefined): void {
    if (token) this.expiries.delete(digest(token));
  }

  /** For tests: the stored keys (token digests). */
  debugKeys(): IterableIterator<string> {
    return this.expiries.keys();
  }
}
