import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../src/ws/protocol";
import { formatTimeLeft, openPermissions, optionStyle, permissionTimeLeftMs, PERMISSION_TIMEOUT_MS } from "./permissions.js";

const at = "2026-11-23T05:00:00.000Z";
const options = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" as const },
  { optionId: "deny", name: "Deny", kind: "reject_once" as const },
];
const ask = (seq: number, requestId: string, title = "Write a file"): AgentEvent => ({
  seq,
  at,
  type: "permission",
  requestId,
  title,
  options,
});
const resolved = (seq: number, requestId: string): AgentEvent => ({
  seq,
  at,
  type: "permission_resolved",
  requestId,
  outcome: "selected",
  optionId: "deny",
});

describe("openPermissions", () => {
  it("is empty when nothing was asked", () => {
    expect(openPermissions([{ seq: 1, at, type: "message", text: "hi" }])).toEqual([]);
  });

  it("lists an unanswered request", () => {
    const open = openPermissions([ask(1, "perm-1")]);
    expect(open.map((p) => p.requestId)).toEqual(["perm-1"]);
    expect(open[0]?.title).toBe("Write a file");
  });

  it("drops a request once it is resolved", () => {
    expect(openPermissions([ask(1, "perm-1"), resolved(2, "perm-1")])).toEqual([]);
  });

  it("keeps the others open, in the order they were asked", () => {
    const open = openPermissions([ask(1, "perm-1"), ask(2, "perm-2"), ask(3, "perm-3"), resolved(4, "perm-2")]);
    expect(open.map((p) => p.requestId)).toEqual(["perm-1", "perm-3"]);
  });

  it("drops everything when the agent exits", () => {
    expect(openPermissions([ask(1, "perm-1"), { seq: 2, at, type: "exit", code: 0, signal: null }])).toEqual([]);
  });
});

describe("permissionTimeLeftMs", () => {
  it("counts down 10 minutes from the event time, never below zero", () => {
    const start = Date.parse(at);
    expect(PERMISSION_TIMEOUT_MS).toBe(10 * 60_000);
    expect(permissionTimeLeftMs(at, start)).toBe(PERMISSION_TIMEOUT_MS);
    expect(permissionTimeLeftMs(at, start + 61_000)).toBe(PERMISSION_TIMEOUT_MS - 61_000);
    expect(permissionTimeLeftMs(at, start + 11 * 60_000)).toBe(0);
  });
});

describe("formatTimeLeft", () => {
  it("shows minutes and zero-padded seconds, rounding up", () => {
    expect(formatTimeLeft(10 * 60_000)).toBe("10:00");
    expect(formatTimeLeft(65_000)).toBe("1:05");
    expect(formatTimeLeft(500)).toBe("0:01");
    expect(formatTimeLeft(0)).toBe("0:00");
  });
});

describe("optionStyle", () => {
  it("labels allow-once as Allow once (primary) and reject-once as Deny (danger)", () => {
    expect(optionStyle({ optionId: "a", name: "Yes", kind: "allow_once" })).toEqual({ label: "Allow once", variant: "primary" });
    expect(optionStyle({ optionId: "d", name: "No", kind: "reject_once" })).toEqual({ label: "Deny", variant: "danger" });
  });

  it("uses the agent's name for other kinds", () => {
    expect(optionStyle({ optionId: "aa", name: "Always allow", kind: "allow_always" })).toEqual({
      label: "Always allow",
      variant: "secondary",
    });
    expect(optionStyle({ optionId: "ra", name: "Never", kind: "reject_always" })).toEqual({ label: "Never", variant: "secondary" });
  });
});
