/**
 * GET /api/fs/folders?path=...&hidden=1 — browse folders on the server (WSL + Windows /mnt/* drives)
 * so the owner can pick a folder in the Import dialog instead of typing paths manually.
 */
import { getServices } from "../../../../src/services";
import { jsonResponse, toErrorResponse } from "../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const pathParam = url.searchParams.get("path") ?? undefined;
    const showHidden = url.searchParams.get("hidden") === "1";
    const result = getServices().browseFolders({
      path: pathParam,
      showHidden,
    });
    return jsonResponse(200, result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
