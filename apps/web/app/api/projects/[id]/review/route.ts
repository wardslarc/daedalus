/**
 * GET /api/projects/:id/review — list in-review tasks for a project (T6.1)
 */
import { getServices } from "../../../../../src/services";
import { HttpError, jsonResponse, toErrorResponse } from "../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!/^[1-9]\d{0,9}$/.test(id)) {
      throw new HttpError(400, "Project id must be a positive whole number.");
    }

    const tasks = await getServices().listInReviewTasks(Number(id));
    return jsonResponse(200, { tasks });
  } catch (err) {
    return toErrorResponse(err);
  }
}
