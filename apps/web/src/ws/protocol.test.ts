import { describe, expect, it } from "vitest";
import { MAX_CLIENT_MESSAGE_BYTES, parseClientMessage, ProtocolError } from "./protocol.js";

const j = (v: unknown) => JSON.stringify(v);

describe("parseClientMessage", () => {
  it("accepts each message type", () => {
    expect(parseClientMessage(j({ id: "1", type: "subscribe", sessionId: "s" }))).toEqual({ id: "1", type: "subscribe", sessionId: "s" });
    expect(parseClientMessage(j({ id: "2", type: "subscribe", sessionId: "s", since: 40 }))).toMatchObject({ since: 40 });
    expect(parseClientMessage(j({ id: "3", type: "unsubscribe", sessionId: "s" }))).toMatchObject({ type: "unsubscribe" });
    expect(parseClientMessage(j({ id: "4", type: "prompt", sessionId: "s", text: "hi" }))).toMatchObject({ text: "hi" });
    expect(parseClientMessage(j({ id: "5", type: "cancel", sessionId: "s" }))).toMatchObject({ type: "cancel" });
    expect(parseClientMessage(j({ id: "6", type: "permission", sessionId: "s", requestId: "perm-1", optionId: "allow" }))).toMatchObject({
      requestId: "perm-1",
      optionId: "allow",
    });
  });

  it.each([
    ["not JSON", "{"],
    ["an array", j([])],
    ["no id", j({ type: "cancel", sessionId: "s" })],
    ["a bad id", j({ id: "a b", type: "cancel", sessionId: "s" })],
    ["an unknown type", j({ id: "1", type: "shell", sessionId: "s" })],
    ["an unknown field", j({ id: "1", type: "cancel", sessionId: "s", command: "rm -rf /" })],
    ["a field from another type", j({ id: "1", type: "cancel", sessionId: "s", text: "x" })],
    ["no sessionId", j({ id: "1", type: "cancel" })],
    ["an empty prompt", j({ id: "1", type: "prompt", sessionId: "s", text: "  " })],
    ["a negative since", j({ id: "1", type: "subscribe", sessionId: "s", since: -1 })],
    ["a permission without optionId", j({ id: "1", type: "permission", sessionId: "s", requestId: "r" })],
  ])("refuses %s", (_, raw) => {
    expect(() => parseClientMessage(raw)).toThrow(ProtocolError);
  });

  it("refuses messages over the size limit", () => {
    const text = "x".repeat(MAX_CLIENT_MESSAGE_BYTES);
    expect(() => parseClientMessage(j({ id: "1", type: "prompt", sessionId: "s", text }))).toThrow(/too large/);
  });
});
