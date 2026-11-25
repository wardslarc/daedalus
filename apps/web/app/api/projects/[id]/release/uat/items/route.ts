/**
 * POST /api/projects/:id/release/uat/items — add UAT item from approved spec (T6.4)
 */
import { getServices } from "../../../../../../../src/services";
import { HttpError, jsonResponse, readJsonBody, toErrorResponse } from "../../../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!/^[1-9]\d{0,9}$/.test(id)) {
      throw new HttpError(400, "Project id must be a positive whole number.");
    }

    const body = await readJsonBody(req);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      throw new HttpError(400, "Item text cannot be empty.");
    }

    const item = await getServices().addUatItemFromSpec(Number(id), text);
    return jsonResponse(201, { ok: true, item });
  } catch (err) {
    return toErrorResponse(err);
  }
}
