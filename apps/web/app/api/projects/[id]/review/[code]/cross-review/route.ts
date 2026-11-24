/**
 * POST /api/projects/:id/review/:code/cross-review — start cross-review for a task (T6.2)
 */
import { getServices } from "../../../../../../../src/services";
import { HttpError, jsonResponse, toErrorResponse } from "../../../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
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

    const result = await getServices().startCrossReview(Number(id), code);
    return jsonResponse(202, result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
