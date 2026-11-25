/**
 * GET /api/projects/:id/release/uat/scripts — list saved UAT scripts with text (T6.5, ADR 0024).
 */
import { getServices } from "../../../../../../../src/services";
import { HttpError, jsonResponse, toErrorResponse } from "../../../../../../../src/api/http";

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

    const scripts = await getServices().listUatScripts(Number(id));
    return jsonResponse(200, { ok: true, scripts });
  } catch (err) {
    return toErrorResponse(err);
  }
}
