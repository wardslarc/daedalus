import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CheckExecError, runCheck } from "../src/check-exec.js";

describe("runCheck executor (T5.3, ADR 0018)", () => {
  const cwd = tmpdir();

  it("handles passing command (exit code 0)", async () => {
    const res = await runCheck("echo 'check-ok'", cwd);
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.output).toContain("check-ok");
  });

  it("handles failing command (non-zero exit code)", async () => {
    const res = await runCheck("echo 'err-msg' >&2; exit 42", cwd);
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(42);
    expect(res.timedOut).toBe(false);
    expect(res.output).toContain("err-msg");
  });

  it("timeout kills child and grandchild (sleep 30)", async () => {
    const start = Date.now();
    // child spawns grandchild
    const res = await runCheck("/bin/sh -c 'sleep 30'", cwd, { timeoutMs: 250 });
    const elapsed = Date.now() - start;

    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    // Finished quickly due to timeout, not after 30s
    expect(elapsed).toBeLessThan(2000);
  });

  it("planted secret env var is not visible to command", async () => {
    const env = {
      ...process.env,
      SECRET_KEY: "supersecretvalue123",
      API_TOKEN: "secrettoken999",
      NORMAL_VAR: "visible_var_123",
    };

    const res = await runCheck("env", cwd, { env });
    expect(res.ok).toBe(true);
    expect(res.output).not.toContain("SECRET_KEY");
    expect(res.output).not.toContain("supersecretvalue123");
    expect(res.output).not.toContain("API_TOKEN");
    expect(res.output).not.toContain("secrettoken999");
    expect(res.output).toContain("NORMAL_VAR=visible_var_123");
  });

  it("redacts secret-like patterns in check output", async () => {
    const res = await runCheck(
      "echo 'Anthropic: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456789'",
      cwd,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("[REDACTED:anthropic]");
    expect(res.output).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456789");
  });

  it("caps output at 1 MiB and keeps the tail", async () => {
    // Generate ~1.4 MiB of numbered lines (> 1 MiB)
    const script = `node -e '
      for (let i = 0; i < 30000; i++) {
        process.stdout.write("LINE " + i + " padding padding padding padding padding\\n");
      }
      process.stdout.write("FINAL_TAIL_MARKER\\n");
    '`;
    const res = await runCheck(script, cwd);
    expect(res.ok).toBe(true);
    expect(Buffer.byteLength(res.output, "utf8")).toBeLessThanOrEqual(1024 * 1024);
    expect(res.output).toContain("FINAL_TAIL_MARKER");
    // Earlier lines should have been truncated
    expect(res.output).not.toContain("LINE 0 ");
  });

  it("refuses empty command", async () => {
    await expect(runCheck("", cwd)).rejects.toThrow(CheckExecError);
    await expect(runCheck("   ", cwd)).rejects.toThrow(CheckExecError);
  });

  it("refuses command over 2000 characters", async () => {
    const longCmd = "echo " + "a".repeat(2001);
    await expect(runCheck(longCmd, cwd)).rejects.toThrow(CheckExecError);
  });

  it("refuses command with NUL byte", async () => {
    await expect(runCheck("echo hello\0world", cwd)).rejects.toThrow(CheckExecError);
  });
});
