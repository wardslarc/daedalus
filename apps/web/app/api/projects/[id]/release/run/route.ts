/**
 * POST /api/projects/:id/release/run — start a release gate run (T6.3)
 */
import { getServices } from "../../../../../../src/services";
import { HttpError, jsonResponse, toErrorResponse } from "../../../../../../src/api/http";

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

    const result = await getServices().startGateRun(Number(id));
    return jsonResponse(202, { ok: true, ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
