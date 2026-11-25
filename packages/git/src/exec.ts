import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitError, stripUserInfo } from "./error.js";

const execFileAsync = promisify(execFile);

export interface ExecGitOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  maxBuffer?: number;
  rawStdout?: boolean;
}

export interface ExecGitResult {
  stdout: string;
  stderr: string;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const CLONE_TIMEOUT_MS = 600_000;

export async function execGit(args: string[], options: ExecGitOptions): Promise<ExecGitResult> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: options.cwd,
      timeout,
      maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
      env: {
        ...process.env,
        ...options.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return {
      stdout: options.rawStdout ? stdout : stripUserInfo(stdout),
      stderr: stripUserInfo(stderr),
    };
  } catch (err: unknown) {
    const nodeErr = err as {
      code?: number | string;
      status?: number;
      stderr?: string;
      message?: string;
    };
    const exitCode = typeof nodeErr.code === "number" ? nodeErr.code : (nodeErr.status ?? null);
    const rawStderr = typeof nodeErr.stderr === "string" ? nodeErr.stderr : "";
    const cleanStderr = stripUserInfo(rawStderr.trim().slice(0, 2048));
    const cleanMsg = cleanStderr || stripUserInfo(nodeErr.message ?? `git ${args[0] ?? ""} failed`);
    throw new GitError(cleanMsg, { exitCode, stderr: cleanStderr });
  }
}

export async function execGitQuiet(args: string[], options: ExecGitOptions): Promise<ExecGitResult | null> {
  try {
    return await execGit(args, options);
  } catch {
    return null;
  }
}
