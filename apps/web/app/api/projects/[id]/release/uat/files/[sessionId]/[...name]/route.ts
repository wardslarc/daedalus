/**
 * GET /api/projects/:id/release/uat/files/:sessionId/:name — serve recorded session files (T6.4, ADR 0021).
 * Security sensitive: validates id, delegates path security checks to resolveUatRecordingPath, and streams response.
 */
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { getServices } from "../../../../../../../../../src/services";
import { HttpError, toErrorResponse } from "../../../../../../../../../src/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; sessionId: string; name?: string[] }> },
): Promise<Response> {
  try {
    const { id, sessionId, name: nameParts } = await ctx.params;
    if (!/^[1-9]\d{0,9}$/.test(id)) {
      throw new HttpError(400, "Project id must be a positive whole number.");
    }

    const { path, contentType, attachment } = getServices().resolveUatRecordingPath(
      Number(id),
      sessionId,
      nameParts ?? [],
    );

    const stat = statSync(path);
    const nodeStream = createReadStream(path);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

    const headers = new Headers();
    headers.set("content-type", contentType);
    headers.set("content-length", String(stat.size));
    headers.set("cache-control", "private, no-cache, no-store");
    if (attachment) {
      const filename = nameParts && nameParts.length > 0 ? nameParts[nameParts.length - 1]! : "trace.zip";
      headers.set("content-disposition", `attachment; filename="${filename}"`);
    }

    return new Response(webStream, {
      status: 200,
      headers,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
