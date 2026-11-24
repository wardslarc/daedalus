/**
 * Redaction for run logs (T3.6, SPEC#Security): every string written to disk goes through here
 * first. Secrets are replaced by `[REDACTED:<kind>]` so a reader still sees that something was
 * there. Deliberately over-eager: a false positive costs a few characters of log, a miss leaks a key.
 */

/** Names that look like they hold a secret. Shared with the agent environment filter (ADR 0010). */
export const SECRET_NAME = /TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|(^|_)(API_?)?KEY($|_)|APIKEY|PRIVATE|(^|_)PAT($|_)/i;

type Rule = { kind: string; re: RegExp; keep?: (m: RegExpExecArray) => [string, string] };

const RULES: Rule[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  // scheme://user:pass@host → keep scheme and host.
  { kind: "userinfo", re: /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, keep: (m) => [m[1]!, "@"] },
  { kind: "bearer", re: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, keep: (m) => [m[1]!, ""] },
  { kind: "basic", re: /(\bBasic\s+)[A-Za-z0-9+/=]{8,}/g, keep: (m) => [m[1]!, ""] },
  { kind: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "github", re: /\bgithub_pat_[A-Za-z0-9_]{30,}|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g },
  { kind: "gitlab", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "slack", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "aws", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "google", re: /\bAIza[0-9A-Za-z_-]{30,40}/g },
  { kind: "npm", re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];

// name = value, name: "value", "name": "value" — keep the name, drop the value.
const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:password|passwd|pwd|secret|token|api_?key|apikey|access_?key|client_secret)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)([^\s"',;}]{4,})/gi;
const CANDIDATE = /[A-Za-z0-9_\-+/=]{32,}/g;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** A value that is a plain word ("await", "required") isn't a secret; one with digits or symbols, or a long one, may be. */
function secretLooking(value: string): boolean {
  return /[^A-Za-z]/.test(value) || value.length >= 12;
}

function applyPatterns(text: string): string {
  let out = text;
  for (const r of RULES) {
    out = out.replace(r.re, (...args) => {
      if (!r.keep) return `[REDACTED:${r.kind}]`;
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      const [before, after] = r.keep(m);
      return `${before}[REDACTED:${r.kind}]${after}`;
    });
  }
  out = out.replace(ASSIGNMENT, (whole, name: string, sep: string, value: string) =>
    value.startsWith("[REDACTED:") || !secretLooking(value) ? whole : `${name}${sep}[REDACTED:assignment]`,
  );
  out = out.replace(CANDIDATE, (s) => {
    if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return s;
    if (/^[0-9a-f-]+$/i.test(s)) return s; // commit SHAs, UUIDs, hashes in hex
    return entropy(s) >= 4.2 ? "[REDACTED:entropy]" : s;
  });
  return out;
}

/** Redact secret-looking substrings from one string. */
export function redact(text: string): string {
  return applyPatterns(text);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A redactor that also removes the exact values of secret-named variables in `env` (8+ chars),
 * so a secret with no recognisable shape is still caught if the server knows it.
 */
export function makeRedactor(env: Record<string, string | undefined>): (text: string) => string {
  const values = Object.entries(env)
    .filter(([name, v]) => v !== undefined && v.length >= 8 && SECRET_NAME.test(name))
    .map(([, v]) => v!)
    .sort((a, b) => b.length - a.length);
  const exact = values.length ? new RegExp(values.map(escapeRe).join("|"), "g") : null;
  return (text) => applyPatterns(exact ? text.replace(exact, "[REDACTED:env]") : text);
}

/** Apply a redactor to every string inside a JSON-like value. */
export function redactDeep<T>(value: T, r: (text: string) => string = redact): T {
  if (typeof value === "string") return r(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, r)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, r);
    return out as T;
  }
  return value;
}

export type SecretMatch = {
  ruleId: string;
  value: string;
};

/**
 * Scan text using the redaction rules and return each matched secret with its ruleId and value.
 * Used by the release gate secret scanner (T6.3, ADR 0020).
 */
export function findSecretsInText(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];

  for (const r of RULES) {
    const re = new RegExp(r.re.source, r.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!r.keep) {
        matches.push({ ruleId: r.kind, value: m[0] });
      } else {
        const [before, after] = r.keep(m);
        const val = m[0].slice(before.length, m[0].length - after.length);
        if (val) {
          matches.push({ ruleId: r.kind, value: val });
        }
      }
    }
  }

  const assignRe = new RegExp(ASSIGNMENT.source, ASSIGNMENT.flags);
  let am: RegExpExecArray | null;
  while ((am = assignRe.exec(text)) !== null) {
    const val = am[3]!;
    if (!val.startsWith("[REDACTED:") && secretLooking(val)) {
      matches.push({ ruleId: "assignment", value: val });
    }
  }

  const candRe = new RegExp(CANDIDATE.source, CANDIDATE.flags);
  let cm: RegExpExecArray | null;
  while ((cm = candRe.exec(text)) !== null) {
    const s = cm[0];
    if (/[A-Za-z]/.test(s) && /[0-9]/.test(s) && !/^[0-9a-f-]+$/i.test(s) && entropy(s) >= 4.2) {
      matches.push({ ruleId: "entropy", value: s });
    }
  }

  return matches;
}

