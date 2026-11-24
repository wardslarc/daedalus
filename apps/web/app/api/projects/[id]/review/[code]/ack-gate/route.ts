/**
 * POST /api/projects/:id/review/:code/ack-gate — acknowledge a needs-ack gate (T6.1)
 */
import { getServices } from "../../../../../../../src/services";
import { HttpError, jsonResponse, readJsonBody, toErrorResponse } from "../../../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
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

    const body = await readJsonBody(req);
    const gateId = typeof body.gateId === "string" ? body.gateId.trim() : "";
    const note = typeof body.note === "string" ? body.note : "";

    if (!gateId) {
      throw new HttpError(400, "Gate ID is required.");
    }
    if (note.trim().length < 1 || note.length > 1000) {
      throw new HttpError(400, "Acknowledgement note must be between 1 and 1000 characters.");
    }

    const result = await getServices().ackGate(Number(id), code, gateId, note);
    return jsonResponse(200, { ok: true, ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
