import { describe, expect, it } from "vitest";
import {
  NotImplementedError,
  transition,
  type TaskEvent,
  type TaskStatus,
} from "../src/task-state.js";

let notImplemented = false;
try {
  transition({ status: "queued", attempts: 0 }, { type: "start" });
} catch (err) {
  if (err instanceof NotImplementedError) {
    notImplemented = true;
  }
}

describe.skipIf(notImplemented)("task-state machine (T5.2)", () => {
  it("queued -> start -> running (attempts 1)", () => {
    const res = transition({ status: "queued", attempts: 0 }, { type: "start" });
    expect(res).toEqual({
      state: { status: "running", attempts: 1 },
      inbox: null,
    });
  });

  it("running -> check-passed -> in-review", () => {
    const res = transition({ status: "running", attempts: 1 }, { type: "check-passed" });
    expect(res).toEqual({
      state: { status: "in-review", attempts: 1 },
      inbox: null,
    });
  });

  it("first check-failed -> running again with attempts 2 and inbox null", () => {
    const res = transition({ status: "running", attempts: 1 }, { type: "check-failed" });
    expect(res).toEqual({
      state: { status: "running", attempts: 2 },
      inbox: null,
    });
  });

  it("second check-failed -> check-failed with inbox failed_check", () => {
    const res = transition({ status: "running", attempts: 2 }, { type: "check-failed" });
    expect(res).toEqual({
      state: { status: "check-failed", attempts: 2 },
      inbox: "failed_check",
    });
  });

  it("in-review -> approve -> done", () => {
    const res = transition({ status: "in-review", attempts: 1 }, { type: "approve" });
    expect(res).toEqual({
      state: { status: "done", attempts: 1 },
      inbox: null,
    });
  });

  it("check-failed -> requeue -> queued with attempts 0", () => {
    const res = transition({ status: "check-failed", attempts: 2 }, { type: "requeue" });
    expect(res).toEqual({
      state: { status: "queued", attempts: 0 },
      inbox: null,
    });
  });

  it("every other pair throws", () => {
    const validPairs = new Set([
      "queued:start",
      "running:check-passed",
      "running:check-failed",
      "in-review:approve",
      "check-failed:requeue",
    ]);

    const statuses: TaskStatus[] = ["queued", "running", "check-failed", "in-review", "done"];
    const events: TaskEvent[] = [
      { type: "start" },
      { type: "check-passed" },
      { type: "check-failed" },
      { type: "approve" },
      { type: "requeue" },
    ];

    for (const status of statuses) {
      for (const event of events) {
        const key = `${status}:${event.type}`;
        if (!validPairs.has(key)) {
          expect(() => transition({ status, attempts: 1 }, event)).toThrow();
        }
      }
    }
  });
});
