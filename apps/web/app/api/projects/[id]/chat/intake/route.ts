/**
 * POST /api/projects/:id/chat/intake — validate and save docs/INTAKE.md (T4.1)
 * Session and CSRF were already checked by server.ts before Next.js sees the request.
 */
import { getServices } from "../../../../../../src/services";
import { HttpError, jsonResponse, readJsonBody, toErrorResponse } from "../../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!/^[1-9]\d{0,9}$/.test(id)) throw new HttpError(400, "Project id must be a positive whole number.");
    const body = await readJsonBody(req, 128 * 1024);
    const result = await getServices().saveIntake(Number(id), {
      content: typeof body.content === "string" ? body.content : undefined,
      fields: typeof body.fields === "object" && body.fields !== null ? (body.fields as Record<string, string>) : undefined,
    });
    return jsonResponse(200, result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
