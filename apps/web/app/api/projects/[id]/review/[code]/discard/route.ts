/**
 * POST /api/projects/:id/review/:code/discard — discard task and branch (T6.1)
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
    const headSha = typeof body.headSha === "string" ? body.headSha.trim() : "";
    if (!/^[0-9a-f]{40}$/i.test(headSha)) {
      throw new HttpError(400, "Valid 40-character hex headSha is required.");
    }

    const result = await getServices().discardTask(Number(id), code, headSha);
    return jsonResponse(200, { ok: true, ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
