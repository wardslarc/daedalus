import { describe, expect, it } from "vitest";
import { sanitizeAgentText } from "./terminal-text.js";

describe("sanitizeAgentText", () => {
  it("keeps plain text, unicode, newlines and tabs", () => {
    expect(sanitizeAgentText("hello\n\tworld ✓ — café")).toBe("hello\n\tworld ✓ — café");
  });

  it("turns CRLF into LF so lines still break", () => {
    expect(sanitizeAgentText("a\r\nb")).toBe("a\nb");
  });

  it("drops a lone carriage return, which would overwrite the current line", () => {
    expect(sanitizeAgentText("safe\rFAKE")).toBe("safeFAKE");
  });

  it("strips CSI sequences: clear screen, cursor moves, colours", () => {
    expect(sanitizeAgentText("a\x1b[2Jb")).toBe("ab");
    expect(sanitizeAgentText("a\x1b[3J\x1b[H\x1b[1;1Hb")).toBe("ab");
    expect(sanitizeAgentText("\x1b[31mred\x1b[0m")).toBe("red");
    expect(sanitizeAgentText("x\x1b[?1049hy")).toBe("xy");
  });

  it("strips OSC sequences (window title, hyperlinks, clipboard) ended by BEL or ST", () => {
    expect(sanitizeAgentText("a\x1b]0;pwned\x07b")).toBe("ab");
    expect(sanitizeAgentText("a\x1b]52;c;ZXZpbA==\x1b\\b")).toBe("ab");
    expect(sanitizeAgentText("\x1b]8;;https://evil.example\x07link\x1b]8;;\x07")).toBe("link");
  });

  it("strips DCS, APC, PM and SOS strings", () => {
    expect(sanitizeAgentText("a\x1bPq#0;2;0;0;0\x1b\\b")).toBe("ab");
    expect(sanitizeAgentText("a\x1b_payload\x1b\\b")).toBe("ab");
    expect(sanitizeAgentText("a\x1b^pm\x1b\\b")).toBe("ab");
    expect(sanitizeAgentText("a\x1bXsos\x1b\\b")).toBe("ab");
  });

  it("strips two-byte escapes such as reset (ESC c) and charset switches", () => {
    expect(sanitizeAgentText("a\x1bcb")).toBe("ab");
    expect(sanitizeAgentText("a\x1b(0b")).toBe("ab");
    expect(sanitizeAgentText("a\x1b7\x1b8b")).toBe("ab");
  });

  it("strips 8-bit C1 controls, which xterm also obeys (0x9b is CSI)", () => {
    expect(sanitizeAgentText("a\x9b2Jb")).toBe("ab");
    expect(sanitizeAgentText("a\x9d0;t\x9cb")).toBe("ab");
    expect(sanitizeAgentText("a\x85b")).toBe("ab");
  });

  it("strips other C0 controls and DEL: backspace, bell, form feed, vertical tab", () => {
    expect(sanitizeAgentText("ab\x08\x08XY")).toBe("abXY");
    expect(sanitizeAgentText("a\x07\x0b\x0c\x00\x7fb")).toBe("ab");
  });

  it("drops an unterminated escape at the end instead of leaking it", () => {
    expect(sanitizeAgentText("ok\x1b[")).toBe("ok");
    expect(sanitizeAgentText("ok\x1b]0;title-without-end")).toBe("ok");
    expect(sanitizeAgentText("ok\x1b")).toBe("ok");
  });
});
