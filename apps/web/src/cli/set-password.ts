/**
 * `pnpm dae set-password`: set or change the one Daedalus password.
 * Interactive: hidden prompt + confirmation. Piped (tests, scripts): first line of stdin.
 */
import { createInterface } from "node:readline";
import { hashPassword, MIN_PASSWORD_LENGTH, writeAuth } from "../auth/password.js";
import { dataDir } from "../data-dir.js";

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPiped(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return "";
}

async function main(): Promise<void> {
  const dir = dataDir();
  let password: string;
  if (process.stdin.isTTY) {
    console.log(`Set the Daedalus password (at least ${MIN_PASSWORD_LENGTH} characters).`);
    password = await readHidden("Password: ");
    const again = await readHidden("Again: ");
    if (password !== again) throw new Error("Passwords don't match. Nothing changed.");
  } else {
    password = await readPiped();
  }
  writeAuth(dir, await hashPassword(password));
  console.log(`Password saved (argon2id hash) to ${dir}/auth.json. Restart dae to sign out existing sessions.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
