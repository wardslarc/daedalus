/**
 * T3.5: permission requests as the Workshop page sees them. Pure helpers, so the console's
 * panel logic is unit-tested without a browser. The page never answers on its own: these only
 * describe what is open and how to label it.
 */
import type { AgentEvent } from "../../../src/ws/protocol";

export type PermissionEvent = Extract<AgentEvent, { type: "permission" }>;
export type PermissionOption = PermissionEvent["options"][number];

/** Matches the server's default (SessionManager `permissionTimeoutMs`). */
export const PERMISSION_TIMEOUT_MS = 10 * 60_000;

/** Requests asked and not yet resolved, oldest first. An agent exit closes them all. */
export function openPermissions(events: readonly AgentEvent[]): PermissionEvent[] {
  const open = new Map<string, PermissionEvent>();
  for (const ev of events) {
    if (ev.type === "permission") open.set(ev.requestId, ev);
    else if (ev.type === "permission_resolved") open.delete(ev.requestId);
    else if (ev.type === "exit") open.clear();
  }
  return [...open.values()];
}

/** Time before the server auto-cancels a request asked at `askedAt`. */
export function permissionTimeLeftMs(askedAt: string, now: number): number {
  return Math.max(0, Date.parse(askedAt) + PERMISSION_TIMEOUT_MS - now);
}

/** "m:ss", rounding up so the last second still shows 0:01. */
export function formatTimeLeft(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export type OptionStyle = { label: string; variant: "primary" | "danger" | "secondary" };

/** Allow once is primary, Deny is danger outline; other option kinds use the agent's name. */
export function optionStyle(option: PermissionOption): OptionStyle {
  if (option.kind === "allow_once") return { label: "Allow once", variant: "primary" };
  if (option.kind === "reject_once") return { label: "Deny", variant: "danger" };
  return { label: option.name, variant: "secondary" };
}
