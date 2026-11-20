/** Strips username and password/token from http/https URLs. */
export function stripUserInfo(text: string): string {
  if (!text) return "";
  return text.replace(/(https?:\/\/)[^/@\s]+@/g, "$1");
}

export class GitError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, options?: { exitCode?: number | null; stderr?: string }) {
    const cleanMessage = stripUserInfo(message);
    super(cleanMessage);
    this.name = "GitError";
    this.exitCode = options?.exitCode ?? null;
    const rawStderr = options?.stderr ?? "";
    this.stderr = stripUserInfo(rawStderr.trim().slice(0, 2048));
  }
}
