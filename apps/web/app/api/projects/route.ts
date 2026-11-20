/**
 * GET /api/projects — list projects with kit pending status (T2.6).
 * Session and CSRF were already checked by server.ts before Next.js sees the request.
 */
import { getServices } from "../../../src/services";
import { jsonResponse, toErrorResponse } from "../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const projects = await getServices().listProjects();
    return jsonResponse(200, { projects });
  } catch (err) {
    return toErrorResponse(err);
  }
}
