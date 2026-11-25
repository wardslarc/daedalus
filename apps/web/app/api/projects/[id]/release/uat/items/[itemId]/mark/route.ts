/**
 * POST /api/projects/:id/release/uat/items/:itemId/mark — mark UAT item pass or fail (T6.4)
 */
import { getServices } from "../../../../../../../../../src/services";
import { HttpError, jsonResponse, readJsonBody, toErrorResponse } from "../../../../../../../../../src/api/http";

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
    if (!/^[1-9]\d{0,9}$/.test(itemId)) {
      throw new HttpError(400, "Item id must be a positive whole number.");
    }

    const body = await readJsonBody(req);
    const result = typeof body.result === "string" ? body.result : "";
    if (result !== "pass" && result !== "fail") {
      throw new HttpError(400, "result must be 'pass' or 'fail'.");
    }

    const headSha = typeof body.headSha === "string" ? body.headSha : "";
    if (!headSha.trim()) {
      throw new HttpError(400, "headSha is required.");
    }

    const note = typeof body.note === "string" ? body.note : undefined;
    const kind = typeof body.kind === "string" ? (body.kind as "bug" | "change") : undefined;
    const checkCommand = typeof body.checkCommand === "string" ? body.checkCommand : undefined;

    const res = await getServices().markUatItem(Number(id), Number(itemId), {
      result,
      headSha,
      note,
      kind,
      checkCommand,
    });

    return jsonResponse(200, { ok: true, ...res });
  } catch (err) {
    return toErrorResponse(err);
  }
}
