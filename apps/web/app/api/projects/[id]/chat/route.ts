/**
 * GET /api/projects/:id/chat — return project info, profile rules, shaping state, and INTAKE.md (T4.1)
 * Session and CSRF were already checked by server.ts before Next.js sees the request.
 */
import { getServices } from "../../../../../src/services";
import { HttpError, jsonResponse, toErrorResponse } from "../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!/^[1-9]\d{0,9}$/.test(id)) throw new HttpError(400, "Project id must be a positive whole number.");
    const chat = await getServices().getProjectChat(Number(id));
    return jsonResponse(200, chat);
  } catch (err) {
    return toErrorResponse(err);
  }
}
