/**
 * GET & POST /api/projects/:id/pipeline — fetch pipeline state or trigger task sync from docs/PLAN.md (T5.1)
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
    const pipeline = await getServices().getProjectPipeline(Number(id));
    return jsonResponse(200, pipeline);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!/^[1-9]\d{0,9}$/.test(id)) throw new HttpError(400, "Project id must be a positive whole number.");
    const pipeline = await getServices().getProjectPipeline(Number(id));
    return jsonResponse(200, pipeline);
  } catch (err) {
    return toErrorResponse(err);
  }
}
