/**
 * POST /api/projects/:id/merge-kit: merge daedalus/kit into the project's default branch
 * (T2.9). Session and CSRF were already checked by server.ts.
 */
import { getServices } from "../../../../../src/services";
import { HttpError, jsonResponse, toErrorResponse } from "../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!/^[1-9]\d{0,9}$/.test(id)) throw new HttpError(400, "Project id must be a positive whole number.");
    const result = await getServices().mergeKit(Number(id));
    return jsonResponse(200, result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
