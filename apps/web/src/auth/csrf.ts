/**
 * CSRF for every non-GET request: the Origin must be our own loopback origin, and the
 * x-csrf-token header must equal the dae_csrf cookie (double submit).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ALLOWED_HOSTNAMES } from "../host-check.js";

export const CSRF_COOKIE = "dae_csrf";
export const CSRF_HEADER = "x-csrf-token";

export function newCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

export type CsrfInput = {
  origin: string | undefined;
  header: string | undefined;
  cookie: string | undefined;
  port: number;
};

export function checkCsrf({ origin, header, cookie, port }: CsrfInput): boolean {
  if (!origin || !ALLOWED_HOSTNAMES.some((name) => origin === `http://${name}:${port}`)) return false;
  if (!header || !cookie) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(cookie);
  return a.length === b.length && timingSafeEqual(a, b);
}
