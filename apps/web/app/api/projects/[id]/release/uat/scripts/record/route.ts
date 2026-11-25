/**
 * POST /api/projects/:id/release/uat/scripts/record — start Playwright codegen for a UAT item (T6.5, ADR 0024).
 * Session and CSRF were already checked by withAuth in server.ts.
 */
import { getServices } from "../../../../../../../../src/services";
import { HttpError, jsonResponse, readJsonBody, toErrorResponse } from "../../../../../../../../src/api/http";

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
    const rawItemId = body.itemId;
    if (
      typeof rawItemId !== "number" ||
      !Number.isInteger(rawItemId) ||
      rawItemId < 1
    ) {
      throw new HttpError(400, "itemId must be a positive whole number.");
    }

    const result = await getServices().startScriptRecording(Number(id), rawItemId);
    return jsonResponse(202, { ok: true, ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
