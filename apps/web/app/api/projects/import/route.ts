/**
 * POST /api/projects/import — import a local repo or a GitHub/GitLab URL (T2.4, ADR 0009).
 * Session and CSRF were already checked by server.ts before Next.js sees the request.
 */
import { getServices } from "../../../../src/services";
import { jsonResponse, readJsonBody, toErrorResponse } from "../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await readJsonBody(req);
    const result = await getServices().importProject({
      source: typeof body.source === "string" ? body.source : "",
      profile: typeof body.profile === "string" ? body.profile : "",
      name: typeof body.name === "string" ? body.name : undefined,
      geminiAllowed: body.geminiAllowed,
    });
    return jsonResponse(201, result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
