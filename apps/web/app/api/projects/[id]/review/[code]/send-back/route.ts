/**
 * POST /api/projects/:id/review/:code/send-back — send back task with review notes (T6.1)
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
    const notes = typeof body.notes === "string" ? body.notes : "";
    if (notes.trim().length < 1 || notes.length > 4000) {
      throw new HttpError(400, "Review notes must be between 1 and 4000 characters.");
    }

    const result = await getServices().sendBack(Number(id), code, notes);
    return jsonResponse(200, { ok: true, ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
