/**
 * GET /api/sessions — running agent sessions. POST /api/sessions { projectId, providerId } —
 * start one (T3.3, ADR 0011). Session and CSRF were already checked by server.ts.
 */
import { getServices } from "../../../src/services";
import { HttpError, jsonResponse, readJsonBody, toErrorResponse } from "../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    return jsonResponse(200, { sessions: getServices().listSessions() });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await readJsonBody(req);
    const { projectId, providerId } = body;
    if (typeof projectId !== "number" || !Number.isInteger(projectId) || projectId < 1) {
      throw new HttpError(400, "projectId must be a positive whole number.");
    }
    if (typeof providerId !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(providerId)) {
      throw new HttpError(400, "providerId must be a provider id from providers.json.");
    }
    return jsonResponse(201, { session: await getServices().startSession(projectId, providerId) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
