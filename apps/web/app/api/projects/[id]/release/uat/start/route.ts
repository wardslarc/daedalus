/**
 * POST /api/projects/:id/release/uat/start — start UAT session with recorded browser (T6.4)
 */
import { getServices } from "../../../../../../../src/services";
import { HttpError, jsonResponse, toErrorResponse } from "../../../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!/^[1-9]\d{0,9}$/.test(id)) {
      throw new HttpError(400, "Project id must be a positive whole number.");
    }

    const session = await getServices().startUatSession(Number(id));
    return jsonResponse(200, { ok: true, session });
  } catch (err) {
    return toErrorResponse(err);
  }
}
