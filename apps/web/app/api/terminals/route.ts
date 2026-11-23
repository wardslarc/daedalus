/**
 * GET /api/terminals — open free terminals. POST /api/terminals { projectId } — open one in the
 * project's folder (T3.7, ADR 0016). Session and CSRF were already checked by server.ts.
 */
import { getServices } from "../../../src/services";
import { HttpError, jsonResponse, readJsonBody, toErrorResponse } from "../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    return jsonResponse(200, { terminals: getServices().listTerminals() });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { projectId } = await readJsonBody(req);
    if (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId < 1) {
      throw new HttpError(400, "projectId must be a positive whole number.");
    }
    return jsonResponse(201, { terminal: await getServices().openTerminal(projectId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
