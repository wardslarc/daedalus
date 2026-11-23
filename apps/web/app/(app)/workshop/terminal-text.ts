/**
 * Filter for agent text before it reaches the console's xterm.js widget.
 *
 * Agent output (replies, thoughts, tool titles, stderr) is untrusted: it can carry terminal
 * control sequences that clear the screen, move the cursor to overwrite earlier lines, set the
 * window title, write the clipboard (OSC 52) or plant hyperlinks. This keeps printable text,
 * newlines and tabs and drops everything else. The console adds its own colours around the
 * filtered text. The owner's free terminal (terminal-console.tsx) is a real shell and stays raw.
 */

const ESC = 0x1b;
const BEL = 0x07;
const C1_ST = 0x9c;
const C1_CSI = 0x9b;
/** C1 controls that open a string ended by ST: DCS, SOS, OSC, PM, APC. */
const C1_STRING_OPENERS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);
/** Characters after ESC that open a string ended by ST or BEL: OSC, DCS, SOS, PM, APC. */
const ESC_STRING_OPENERS = new Set(["]", "P", "X", "^", "_"]);

/** Index just past a CSI sequence whose parameters start at `i`, or `len` if unterminated. */
function skipCsi(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    i++;
    if (c >= 0x40 && c <= 0x7e) return i;
  }
  return s.length;
}

/** Index just past a control string whose body starts at `i`, or `len` if unterminated. */
function skipString(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === BEL || c === C1_ST) return i + 1;
    if (c === ESC && s[i + 1] === "\\") return i + 2;
    i++;
  }
  return s.length;
}

export function sanitizeAgentText(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);

    if (c === ESC) {
      const next = text[i + 1];
      if (next === undefined) break;
      if (next === "[") {
        i = skipCsi(text, i + 2);
      } else if (ESC_STRING_OPENERS.has(next)) {
        i = skipString(text, i + 2);
      } else {
        // nF escapes: intermediates 0x20–0x2f then one final byte, e.g. ESC ( 0.
        let j = i + 1;
        while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
        i = Math.min(j + 1, text.length);
      }
      continue;
    }

    if (c >= 0x80 && c <= 0x9f) {
      if (c === C1_CSI) i = skipCsi(text, i + 1);
      else if (C1_STRING_OPENERS.has(c)) i = skipString(text, i + 1);
      else i++;
      continue;
    }

    if (c === 0x0a || c === 0x09) {
      out += text[i];
    } else if (c === 0x0d) {
      // CRLF stays a line break; a lone CR would return the cursor and overwrite the line.
      if (text.charCodeAt(i + 1) === 0x0a) {
        out += "\n";
        i++;
      }
    } else if (c >= 0x20 && c !== 0x7f) {
      out += text[i];
    }
    i++;
  }
  return out;
}
