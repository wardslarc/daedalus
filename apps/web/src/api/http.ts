/** Shared helpers for JSON API route handlers. Auth and CSRF already ran in server.ts. */
import { ProfileRuleError } from "@daedalus/core/profiles";
import { ImportError } from "@daedalus/projects";

export const MAX_JSON_BYTES = 8 * 1024;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** Parse a small JSON object body, or throw an ImportError with the right status. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new ImportError("Send JSON (content-type: application/json).", 415);
  }
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new ImportError("Request body is too large.", 413);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ImportError("Request body isn't valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ImportError("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function jsonResponse(status: number, body: unknown): Response {
  return json(status, body);
}

/** Known errors keep their message; anything else is logged and becomes a generic 500. */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof ImportError) return json(err.status, { error: err.message });
  if (err instanceof ProfileRuleError) return json(403, { error: err.message });
  console.error("[api] unexpected error:", err);
  return json(500, { error: "Something went wrong on the Daedalus server. Check its terminal for details." });
}
