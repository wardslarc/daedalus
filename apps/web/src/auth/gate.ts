/** Who may reach what. Pure, so every rule is unit-tested; server.ts acts on the result. */
export type GateInput = {
  method: string;
  /** URL path only, no query string. Compared exactly; never normalized here. */
  path: string;
  hasSession: boolean;
  passwordSet: boolean;
  csrfOk: boolean;
};

export type GateDecision =
  | { kind: "allow" }
  | { kind: "redirect"; to: string }
  | { kind: "status"; status: 401 | 403 }
  | { kind: "setup" };

export const LOGIN_PAGE = "/login";
export const LOGIN_API = "/api/login";
export const HOME = "/projects";

const isAsset = (path: string): boolean => path.startsWith("/_next/static/") || path === "/favicon.ico";

export function decide({ method, path, hasSession, passwordSet, csrfOk }: GateInput): GateDecision {
  if (isAsset(path)) return { kind: "allow" };
  if (!passwordSet) return { kind: "setup" };

  const safe = method === "GET" || method === "HEAD";
  if (!safe && !csrfOk) return { kind: "status", status: 403 };

  if (path === LOGIN_API && !safe) return { kind: "allow" };
  if (path === LOGIN_PAGE && safe) return hasSession ? { kind: "redirect", to: HOME } : { kind: "allow" };

  if (hasSession) return { kind: "allow" };
  return path.startsWith("/api/") ? { kind: "status", status: 401 } : { kind: "redirect", to: LOGIN_PAGE };
}
