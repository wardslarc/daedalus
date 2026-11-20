/**
 * POST /api/projects/new — create a new project from the kit (T2.5).
 * Session and CSRF were already checked by server.ts before Next.js sees the request.
 */
import { getServices } from "../../../../src/services";
import { jsonResponse, readJsonBody, toErrorResponse } from "../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await readJsonBody(req);
    const result = await getServices().createProject({
      name: typeof body.name === "string" ? body.name : "",
      profile: typeof body.profile === "string" ? body.profile : "",
      geminiAllowed: body.geminiAllowed,
    });
    return jsonResponse(201, result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
