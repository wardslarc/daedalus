/**
 * POST /api/projects/:id/release/findings/:findingId/decide — decide finding outcome (T6.3)
 */
import { getServices } from "../../../../../../../../src/services";
import { HttpError, jsonResponse, readJsonBody, toErrorResponse } from "../../../../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; findingId: string }> },
): Promise<Response> {
  try {
    const { id, findingId } = await ctx.params;
    if (!/^[1-9]\d{0,9}$/.test(id)) {
      throw new HttpError(400, "Project id must be a positive whole number.");
    }
    if (!/^[1-9]\d{0,9}$/.test(findingId)) {
      throw new HttpError(400, "Finding id must be a positive whole number.");
    }

    const body = await readJsonBody(req);
    const outcome = typeof body.outcome === "string" ? body.outcome : "";
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const checkCommand = typeof body.checkCommand === "string" ? body.checkCommand : undefined;

    const result = await getServices().decideFinding(Number(id), Number(findingId), {
      outcome,
      reason,
      checkCommand,
    });
    return jsonResponse(200, { ok: true, ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
