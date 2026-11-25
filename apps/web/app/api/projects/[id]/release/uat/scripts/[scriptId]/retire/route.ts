/**
 * POST /api/projects/:id/release/uat/scripts/:scriptId/retire — retire an active UAT script with a reason (T6.5, ADR 0024).
 * Session and CSRF were already checked by withAuth in server.ts.
 */
import { getServices } from "../../../../../../../../../src/services";
import { HttpError, jsonResponse, readJsonBody, toErrorResponse } from "../../../../../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; scriptId: string }> },
): Promise<Response> {
  try {
    const { id, scriptId } = await ctx.params;
    if (!/^[1-9]\d{0,9}$/.test(id)) {
      throw new HttpError(400, "Project id must be a positive whole number.");
    }
    if (!/^[1-9]\d{0,9}$/.test(scriptId)) {
      throw new HttpError(400, "Script id must be a positive whole number.");
    }

    const body = await readJsonBody(req);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 1 || reason.length > 500) {
      throw new HttpError(400, "Retirement reason must be between 1 and 500 characters.");
    }

    const script = await getServices().retireUatScript(Number(id), Number(scriptId), reason);
    return jsonResponse(200, { ok: true, script });
  } catch (err) {
    return toErrorResponse(err);
  }
}
