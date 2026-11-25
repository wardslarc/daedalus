/**
 * POST /api/projects/:id/release/uat/config — save UAT app config (T6.4)
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
    const startCommand = typeof body.startCommand === "string" ? body.startCommand : "";
    const appUrl = typeof body.appUrl === "string" ? body.appUrl : "";

    const config = await getServices().setUatAppConfig(Number(id), {
      startCommand,
      appUrl,
    });

    return jsonResponse(200, { ok: true, config });
  } catch (err) {
    return toErrorResponse(err);
  }
}
