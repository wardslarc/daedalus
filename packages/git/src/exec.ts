import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

export const BASE_CONFIG_ARGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "core.editor=true",
  "-c",
  "sequence.editor=true",
  "-c",
  "log.showSignature=false",
  "-c",
  "merge.verifySignatures=false",
  "-c",
  "gpg.program=false",
  "-c",
  "gpg.openpgp.program=false",
  "-c",
  "gpg.x509.program=false",
  "-c",
  "gpg.ssh.program=false",
  "-c",
  "diff.ignoreSubmodules=dirty",
  "-c",
  "submodule.recurse=false",
  "-c",
  "status.submoduleSummary=false",
];

export const SKIP_LISTING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "rev-parse",
  "show-ref",
  "check-ref-format",
  "for-each-ref",
  "cat-file",
  "rev-list",
  "merge-base",
  "symbolic-ref",
  "config",
  "ls-remote",
  "init",
  "clone",
]);

export const DIFF_EXT_TEXTCONV_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "diff",
  "log",
  "show",
  "format-patch",
]);

export const IGNORE_SUBMODULES_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "diff",
  "log",
  "show",
  "format-patch",
  "stash",
]);

const SAFE_DRIVER_NAME_REGEX = /^[A-Za-z0-9._-]+$/;
const SAFE_SUBMODULE_NAME_REGEX = /^[A-Za-z0-9._/-]+$/;

/** Observable listing counter for testing; kept out of public API docs. */
export let listingCounter = 0;

export function resetListingCounter(): void {
  listingCounter = 0;
}

export function findSubcommandIndex(args: string[]): number {
  let idx = 0;
  while (idx < args.length) {
    if (args[idx] === "-c") {
      idx += 2;
    } else if (args[idx]?.startsWith("-c")) {
      idx += 1;
    } else {
      break;
    }
  }
  return idx < args.length ? idx : -1;
}

export function findSubcommand(args: string[]): string | undefined {
  const idx = findSubcommandIndex(args);
  return idx !== -1 ? args[idx] : undefined;
}

export async function execGit(args: string[], options: ExecGitOptions): Promise<ExecGitResult> {
  for (const arg of args) {
    if (arg === "--ignore-submodules" || arg.startsWith("--ignore-submodules=")) {
      if (arg !== "--ignore-submodules=all" && arg !== "--ignore-submodules=dirty") {
        throw new GitError(`Invalid --ignore-submodules flag: '${arg}' is not allowed`);
      }
    }
  }

  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;
  const env = {
    ...process.env,
    ...options.env,
    GIT_TERMINAL_PROMPT: "0",
  };

  try {
    const subcommandIdx = findSubcommandIndex(args);
    const subcommand = subcommandIdx !== -1 ? args[subcommandIdx] : undefined;
    const driverArgs: string[] = [];

    const shouldRunListing = !subcommand || !SKIP_LISTING_SUBCOMMANDS.has(subcommand);

    if (shouldRunListing) {
      listingCounter++;
      const configArgs = [
        ...BASE_CONFIG_ARGS,
        "config",
        "-z",
        "--name-only",
        "--get-regexp",
        "^(filter|merge|diff|submodule)\\.",
      ];
      let configStdout = "";
      try {
        const { stdout } = await execFileAsync("git", configArgs, {
          cwd: options.cwd,
          timeout,
          maxBuffer,
          env,
        });
        configStdout = stdout;
      } catch (err: unknown) {
        const nodeErr = err as {
          code?: number | string;
          status?: number;
          stderr?: string;
          message?: string;
        };
        const exitCode = typeof nodeErr.code === "number" ? nodeErr.code : (nodeErr.status ?? null);
        if (exitCode === 1) {
          // exit code 1 means "none"
          configStdout = "";
        } else {
          const rawStderr = typeof nodeErr.stderr === "string" ? nodeErr.stderr : "";
          const cleanStderr = stripUserInfo(rawStderr.trim().slice(0, 2048));
          const cleanMsg = cleanStderr || stripUserInfo(nodeErr.message ?? "git config --get-regexp failed");
          throw new GitError(cleanMsg, { exitCode, stderr: cleanStderr });
        }
      }

      const filterNames = new Set<string>();
      const mergeNames = new Set<string>();
      const diffNames = new Set<string>();
      const submoduleNames = new Set<string>();

      if (configStdout) {
        for (const key of configStdout.split("\0")) {
          if (!key) continue;
          let section: "filter" | "merge" | "diff" | "submodule" | null = null;
          if (key.startsWith("filter.")) {
            section = "filter";
          } else if (key.startsWith("merge.")) {
            section = "merge";
          } else if (key.startsWith("diff.")) {
            section = "diff";
          } else if (key.startsWith("submodule.")) {
            section = "submodule";
          } else {
            throw new GitError("Unsafe filter name in repo config");
          }

          const firstDot = section.length;
          const lastDot = key.lastIndexOf(".");
          if (lastDot === key.length - 1) {
            throw new GitError(
              section === "submodule"
                ? "Unsafe submodule name in repo config"
                : "Unsafe filter name in repo config",
            );
          }
          if (firstDot === lastDot) {
            // Exactly one dot: plain setting (section.variable) -> skip it
            continue;
          }
          const name = key.slice(firstDot + 1, lastDot);
          if (section === "submodule") {
            if (!name || !SAFE_SUBMODULE_NAME_REGEX.test(name)) {
              throw new GitError("Unsafe submodule name in repo config");
            }
            submoduleNames.add(name);
          } else {
            if (!name || !SAFE_DRIVER_NAME_REGEX.test(name)) {
              throw new GitError("Unsafe filter name in repo config");
            }
            if (section === "filter") {
              filterNames.add(name);
            } else if (section === "merge") {
              mergeNames.add(name);
            } else if (section === "diff") {
              diffNames.add(name);
            }
          }
        }
      }

      // Check <toplevel>/.gitmodules
      let toplevel: string | null = null;
      try {
        const { stdout: tlStdout } = await execFileAsync(
          "git",
          [...BASE_CONFIG_ARGS, "rev-parse", "--show-toplevel"],
          { cwd: options.cwd, timeout, maxBuffer, env },
        );
        toplevel = tlStdout.trim();
      } catch {
        // cwd has no work tree (e.g. bare repo)
        toplevel = null;
      }

      if (toplevel) {
        const gitmodulesPath = join(toplevel, ".gitmodules");
        if (existsSync(gitmodulesPath)) {
          let gitmodulesStdout = "";
          try {
            const { stdout } = await execFileAsync(
              "git",
              [
                ...BASE_CONFIG_ARGS,
                "config",
                "-z",
                "--name-only",
                "--file",
                gitmodulesPath,
                "--get-regexp",
                "^submodule\\.",
              ],
              { cwd: options.cwd, timeout, maxBuffer, env },
            );
            gitmodulesStdout = stdout;
          } catch (err: unknown) {
            const nodeErr = err as {
              code?: number | string;
              status?: number;
              stderr?: string;
              message?: string;
            };
            const exitCode = typeof nodeErr.code === "number" ? nodeErr.code : (nodeErr.status ?? null);
            if (exitCode === 1) {
              // exit code 1 means "none"
              gitmodulesStdout = "";
            } else {
              const rawStderr = typeof nodeErr.stderr === "string" ? nodeErr.stderr : "";
              const cleanStderr = stripUserInfo(rawStderr.trim().slice(0, 2048));
              const cleanMsg = cleanStderr || stripUserInfo(nodeErr.message ?? "git config --file .gitmodules failed");
              throw new GitError(cleanMsg, { exitCode, stderr: cleanStderr });
            }
          }

          if (gitmodulesStdout) {
            for (const key of gitmodulesStdout.split("\0")) {
              if (!key) continue;
              if (!key.startsWith("submodule.")) {
                throw new GitError("Unsafe submodule name in .gitmodules");
              }
              const firstDot = 9; // "submodule".length
              const lastDot = key.lastIndexOf(".");
              if (lastDot === key.length - 1) {
                throw new GitError("Unsafe submodule name in .gitmodules");
              }
              if (firstDot === lastDot) {
                continue;
              }
              const name = key.slice(firstDot + 1, lastDot);
              if (!name || !SAFE_SUBMODULE_NAME_REGEX.test(name)) {
                throw new GitError("Unsafe submodule name in .gitmodules");
              }
              submoduleNames.add(name);
            }
          }
        }
      }

      for (const name of [...filterNames].sort()) {
        driverArgs.push(
          "-c",
          `filter.${name}.process=`,
          "-c",
          `filter.${name}.clean=cat`,
          "-c",
          `filter.${name}.smudge=cat`,
          "-c",
          `filter.${name}.required=false`,
        );
      }

      for (const name of [...mergeNames].sort()) {
        driverArgs.push("-c", `merge.${name}.driver=false`);
      }

      for (const name of [...diffNames].sort()) {
        driverArgs.push("-c", `diff.${name}.textconv=cat`);
      }

      for (const name of [...submoduleNames].sort()) {
        driverArgs.push("-c", `submodule.${name}.ignore=dirty`);
      }
    }

    let finalArgs = args;
    if (subcommand) {
      const flagsToInsert: string[] = [];

      if (IGNORE_SUBMODULES_SUBCOMMANDS.has(subcommand)) {
        const hasIgnoreSubmodules = args.some(
          (a) => a === "--ignore-submodules" || a.startsWith("--ignore-submodules="),
        );
        if (!hasIgnoreSubmodules) {
          flagsToInsert.push("--ignore-submodules=dirty");
        }
      }

      if (DIFF_EXT_TEXTCONV_SUBCOMMANDS.has(subcommand)) {
        if (!args.includes("--no-ext-diff")) {
          flagsToInsert.push("--no-ext-diff");
        }
        if (!args.includes("--no-textconv")) {
          flagsToInsert.push("--no-textconv");
        }
      } else if (subcommand === "blame") {
        if (!args.includes("--no-textconv")) {
          flagsToInsert.push("--no-textconv");
        }
      }

      if (flagsToInsert.length > 0) {
        finalArgs = [
          ...args.slice(0, subcommandIdx + 1),
          ...flagsToInsert,
          ...args.slice(subcommandIdx + 1),
        ];
      }
    }

    const realArgv = [...BASE_CONFIG_ARGS, ...driverArgs, ...finalArgs];

    const { stdout, stderr } = await execFileAsync("git", realArgv, {
      cwd: options.cwd,
      timeout,
      maxBuffer,
      env,
    });
    return {
      stdout: options.rawStdout ? stdout : stripUserInfo(stdout),
      stderr: stripUserInfo(stderr),
    };
  } catch (err: unknown) {
    if (err instanceof GitError) {
      throw err;
    }
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
