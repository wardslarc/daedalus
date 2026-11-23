/** POST /api/terminals/:id/close — close a free terminal (T3.7). Session and CSRF already checked. */
import { getServices } from "../../../../../src/services";
import { HttpError, jsonResponse, toErrorResponse } from "../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, "That isn't a terminal id.");
    await getServices().closeTerminal(id);
    return jsonResponse(200, { closed: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
