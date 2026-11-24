/**
 * GET /api/projects/:id/review/:code — get review data for a task (T6.1)
 */
import { getServices } from "../../../../../../src/services";
import { HttpError, jsonResponse, toErrorResponse } from "../../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; code: string }> },
): Promise<Response> {
  try {
    const { id, code } = await ctx.params;
    if (!/^[1-9]\d{0,9}$/.test(id)) {
      throw new HttpError(400, "Project id must be a positive whole number.");
    }
    if (!/^[A-Za-z][A-Za-z0-9.-]{0,31}$/.test(code)) {
      throw new HttpError(400, "Invalid task code.");
    }

    const review = await getServices().getReview(Number(id), code);
    return jsonResponse(200, review);
  } catch (err) {
    return toErrorResponse(err);
  }
}
