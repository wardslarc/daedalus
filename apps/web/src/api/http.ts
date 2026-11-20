/**
 * Shared helpers for JSON API route handlers. Auth and CSRF already ran in server.ts.
 * No runtime imports from workspace packages (see services.ts): errors are recognised by
 * name, because the classes a route sees may be different copies from the server's.
 */
export const MAX_JSON_BYTES = 8 * 1024;

/** An error that carries its own HTTP status and a message safe to show the owner. */
export class HttpError extends Error {
  override name = "HttpError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Parse a small JSON object body, or throw an HttpError. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send JSON (content-type: application/json).");
  }
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new HttpError(413, "Request body is too large.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body isn't valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

type Named = { name?: unknown; message?: unknown; status?: unknown };

/** Known errors keep their message; anything else is logged and becomes a generic 500. */
export function toErrorResponse(err: unknown): Response {
  const e = (typeof err === "object" && err !== null ? err : {}) as Named;
  const message = typeof e.message === "string" ? e.message : "";
  if ((e.name === "HttpError" || e.name === "ImportError") && typeof e.status === "number") {
    return jsonResponse(e.status, { error: message });
  }
  if (e.name === "ProfileRuleError") return jsonResponse(403, { error: message });
  console.error("[api] unexpected error:", err);
  return jsonResponse(500, { error: "Something went wrong on the Daedalus server. Check its terminal for details." });
}
