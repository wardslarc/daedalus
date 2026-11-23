/**
 * POST /api/projects/:id/chat/plan — start Claude plan session, approve docs/PLAN.md, or start milestone (T4.4)
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
      const started = await getServices().startPlanSession(projectId);
      return jsonResponse(200, started);
    }

    if (action === "start-milestone") {
      const startedMilestone = await getServices().startMilestone(projectId, {
        version: typeof body.version === "string" ? body.version : undefined,
      });
      return jsonResponse(200, startedMilestone);
    }

    const approved = await getServices().approvePlan(projectId, {
      content: typeof body.content === "string" ? body.content : undefined,
    });
    return jsonResponse(200, approved);
  } catch (err) {
    return toErrorResponse(err);
  }
}
