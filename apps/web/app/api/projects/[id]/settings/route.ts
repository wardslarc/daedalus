/**
 * POST /api/projects/:id/settings — update project settings (T2.7, ADR 0008).
 * Session and CSRF were already checked by server.ts before Next.js sees the request.
 */
import { getServices } from "../../../../../src/services";
import { HttpError, jsonResponse, readJsonBody, toErrorResponse } from "../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!/^[1-9]\d{0,9}$/.test(id)) throw new HttpError(400, "Project id must be a positive whole number.");
    const body = await readJsonBody(req);
    const result = await getServices().updateProjectSettings(Number(id), {
      profile: typeof body.profile === "string" ? body.profile : "",
      geminiAllowed: body.geminiAllowed,
    });
    return jsonResponse(200, result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
