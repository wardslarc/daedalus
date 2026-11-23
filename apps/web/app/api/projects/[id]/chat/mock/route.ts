/**
 * POST /api/projects/:id/chat/mock — start mock session with chosen provider or approve mock (T4.3)
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
    const projectId = Number(id);
    const action = typeof body.action === "string" ? body.action : "approve";

    if (action === "start") {
      const providerId = typeof body.providerId === "string" ? body.providerId : "claude";
      const started = await getServices().startMockSession(projectId, providerId);
      return jsonResponse(200, started);
    }

    const approved = await getServices().approveMock(projectId, {
      artifactUrl: typeof body.artifactUrl === "string" ? body.artifactUrl : undefined,
      approvedBy: typeof body.approvedBy === "string" ? body.approvedBy : undefined,
      approvedAt: typeof body.approvedAt === "string" ? body.approvedAt : undefined,
    });
    return jsonResponse(200, approved);
  } catch (err) {
    return toErrorResponse(err);
  }
}
