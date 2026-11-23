/** POST /api/sessions/:id/stop — stop an agent session (T3.3). Session and CSRF already checked. */
import { getServices } from "../../../../../src/services";
import { HttpError, jsonResponse, toErrorResponse } from "../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "That isn't a session id.");
    await getServices().stopSession(id);
    return jsonResponse(200, { stopped: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
