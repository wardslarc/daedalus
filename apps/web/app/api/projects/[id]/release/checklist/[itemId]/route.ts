/**
 * POST /api/projects/:id/release/checklist/:itemId — set ship checklist item ticked state (T6.3)
 */
import { getServices } from "../../../../../../../src/services";
import { HttpError, jsonResponse, readJsonBody, toErrorResponse } from "../../../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; itemId: string }> },
): Promise<Response> {
  try {
    const { id, itemId } = await ctx.params;
    if (!/^[1-9]\d{0,9}$/.test(id)) {
      throw new HttpError(400, "Project id must be a positive whole number.");
    }
    if (!itemId || typeof itemId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(itemId)) {
      throw new HttpError(400, "Invalid item id.");
    }

    const body = await readJsonBody(req);
    if (typeof body.ticked !== "boolean") {
      throw new HttpError(400, "ticked must be a boolean.");
    }

    const result = await getServices().setChecklistItem(Number(id), itemId, body.ticked);
    return jsonResponse(200, { ok: true, ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
