import { spawn } from "node:child_process";
import { makeRedactor, scrubEnv } from "@daedalus/providers";

export class CheckExecError extends Error {
  override name = "CheckExecError";
  constructor(message: string) {
    super(message);
  }
}

export type CheckResult = {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
};

export type RunCheckOptions = {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  onPid?: (pid: number) => void;
};

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB

export const runningCheckPids = new Set<number>();

export function killCheckProcessGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: already gone
  }
}

export function killAllRunningChecks(): void {
  for (const pid of runningCheckPids) {
    killCheckProcessGroup(pid, "SIGKILL");
  }
  runningCheckPids.clear();
}

/**
 * Execute a check command safely in `cwd` (T5.3, ADR 0018).
 * Command is spawned in /bin/sh -c with scrubbed environment and detached process group.
 * Interleaved stdout/stderr is capped at 1 MiB keeping the tail and redacted with makeRedactor.
 */
export async function runCheck(
  command: string,
  cwd: string,
  options?: RunCheckOptions,
): Promise<CheckResult> {
  if (typeof command !== "string" || command.trim() === "") {
    throw new CheckExecError("Command cannot be empty");
  }
  if (command.length > 2000) {
    throw new CheckExecError("Command exceeds 2000 characters");
  }
  if (command.includes("\0")) {
    throw new CheckExecError("Command contains NUL byte");
  }

  const baseEnv = options?.env ?? process.env;
  const cleanEnv = scrubEnv(baseEnv) as NodeJS.ProcessEnv;
  const redactor = makeRedactor(baseEnv);
  const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000;

  return new Promise<CheckResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd,
        env: cleanEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        ok: false,
        exitCode: 1,
        timedOut: false,
        output: redactor(err instanceof Error ? err.message : String(err)),
      });
      return;
    }

    const pid = child.pid;
    if (pid) {
      runningCheckPids.add(pid);
      options?.onPid?.(pid);
    }

    const outputChunks: Buffer[] = [];
    let totalBytes = 0;

    const appendOutput = (data: Buffer | string) => {
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      outputChunks.push(buf);
      totalBytes += buf.length;
      while (outputChunks.length > 1 && totalBytes - outputChunks[0]!.length >= MAX_OUTPUT_BYTES) {
        totalBytes -= outputChunks[0]!.length;
        outputChunks.shift();
      }
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      if (pid) {
        killCheckProcessGroup(pid, "SIGTERM");
        killTimer = setTimeout(() => {
          killCheckProcessGroup(pid, "SIGKILL");
        }, 3000);
      }
    }, timeoutMs);

    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (pid) runningCheckPids.delete(pid);

      const fullBuf = Buffer.concat(outputChunks);
      let startOffset = fullBuf.length > MAX_OUTPUT_BYTES ? fullBuf.length - MAX_OUTPUT_BYTES : 0;
      // Skip continuation bytes to avoid slicing in the middle of a multi-byte UTF-8 character
      while (startOffset < fullBuf.length && (fullBuf[startOffset]! & 0xc0) === 0x80) {
        startOffset++;
      }
      const tailBuf = fullBuf.subarray(startOffset);
      const output = tailBuf.toString("utf8");

      const finalOutput = redactor(output);
      const ok = !timedOut && exitCode === 0;

      resolve({
        ok,
        exitCode: timedOut ? null : exitCode,
        timedOut,
        output: finalOutput,
      });
    };

    child.on("close", (code) => finish(code));
    child.on("error", () => finish(1));
  });
}
