/**
 * A tiny ACP agent for tests. Behaviour is chosen by the prompt text:
 *   echo <text>        reply with <text> (in two chunks)
 *   cwd                reply with the working directory
 *   env <NAME>         reply with that variable, or "(unset)"
 *   sleep <ms>         wait (cancellable), then reply "slept"
 *   permission         ask the client for permission; reply allowed / denied / cancelled
 *   permission-kind    ask the client for permission with a specific kind (e.g. read, edit, none)
 *   stubborn-child     start a child that ignores SIGTERM; reply with its pid
 *   flood <n>          send n message chunks
 *   exit               exit the process with code 3
 *   [Spec interview]*  draft docs/SPEC.md from docs/INTAKE.md and ask for ## Verify criteria (T4.2)
 *   write-spec-draft   write a draft docs/SPEC.md without ## Verify (T4.2)
 *   write-spec-verify  update docs/SPEC.md to include ## Verify (T4.2)
 *   [Cross-review]*    cross-review findings (T6.2): FAKE:ask-write requests edit & read permissions;
 *                      FAKE:write-file writes tampered.txt; FAKE:write-and-stall writes tampered.txt and stalls;
 *                      FAKE:delete-git deletes .git in its cwd; FAKE:rewrite-git rewrites .git in its cwd;
 *                      FAKE:write-common-hook writes <common-dir>/hooks/post-checkout;
 *                      FAKE:rewrite-commondir rewrites its own worktrees/<name>/commondir;
 *                      FAKE:add-alternates adds <common-dir>/objects/info/alternates;
 *                      FAKE:bad-json replies without json; otherwise replies with 3 findings.
 *   [Triage]*          triage findings (T6.2): first finding must-fix, others should-fix / nit.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

let cancel: (() => void) | null = null;

const say = (client: acp.AgentContext, sessionId: string, text: string) =>
  client.notify(acp.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });

const app = acp
  .agent({ name: "fake-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
    agentInfo: { name: "fake-agent", version: "1.0.0" },
  }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: "fake-session" }))
  .onNotification(acp.methods.agent.session.cancel, () => {
    cancel?.();
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const first = params.prompt[0];
    const input = first && first.type === "text" ? first.text : "";
    const [cmd = "", ...rest] = input.split(" ");
    const arg = rest.join(" ");
    const sid = params.sessionId;

    switch (cmd) {
      case "echo":
        await say(client, sid, arg.slice(0, Math.ceil(arg.length / 2)));
        await say(client, sid, arg.slice(Math.ceil(arg.length / 2)));
        break;
      case "cwd":
        await say(client, sid, process.cwd());
        break;
      case "env":
        await say(client, sid, process.env[arg] ?? "(unset)");
        break;
      case "sleep": {
        const cancelled = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), Number(arg));
          cancel = () => {
            clearTimeout(t);
            resolve(true);
          };
        });
        cancel = null;
        if (cancelled) return { stopReason: "cancelled" as const };
        await say(client, sid, "slept");
        break;
      }
      case "permission": {
        const res = (await client.request(acp.methods.client.session.requestPermission, {
          sessionId: sid,
          toolCall: { toolCallId: "tool-1", title: "Write a file", kind: "edit", status: "pending" },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        })) as acp.RequestPermissionResponse;
        const outcome = res.outcome.outcome === "cancelled" ? "cancelled" : res.outcome.optionId === "allow" ? "allowed" : "denied";
        await say(client, sid, outcome);
        break;
      }
      case "permission-kind": {
        const [kindStr, locPath] = arg.split(" ");
        const kind = kindStr === "none" ? undefined : (kindStr || "edit");
        const locations = locPath && locPath !== "none" ? [{ path: locPath }] : undefined;
        const res = (await client.request(acp.methods.client.session.requestPermission, {
          sessionId: sid,
          toolCall: {
            toolCallId: "tool-1",
            title: "Tool request",
            ...(kind ? { kind } : {}),
            ...(locations ? { locations } : {}),
            status: "pending",
          },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        })) as acp.RequestPermissionResponse;
        const outcome = res.outcome.outcome === "cancelled" ? "cancelled" : res.outcome.optionId === "allow" ? "allowed" : "denied";
        await say(client, sid, outcome);
        break;
      }
      case "stubborn-child": {
        const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
        await say(client, sid, String(child.pid));
        break;
      }
      case "flood":
        for (let i = 0; i < Number(arg); i++) await say(client, sid, ".");
        break;
      case "exit":
        process.exit(3);
        break;
      case "write-spec-draft": {
        const docsDir = join(process.cwd(), "docs");
        mkdirSync(docsDir, { recursive: true });
        const draft = [
          "# Spec — Draft",
          "",
          "## Overview",
          `- ${arg || "Drafted from intake during spec interview."}`,
          "",
        ].join("\n");
        writeFileSync(join(docsDir, "SPEC.md"), draft, "utf8");
        await say(client, sid, "Drafted docs/SPEC.md without ## Verify. What checks should go into ## Verify?");
        break;
      }
      case "write-spec-verify": {
        const docsDir = join(process.cwd(), "docs");
        mkdirSync(docsDir, { recursive: true });
        const specPath = join(docsDir, "SPEC.md");
        const existing = existsSync(specPath)
          ? readFileSync(specPath, "utf8").replace(/\n*##\s+Verify[\s\S]*$/i, "")
          : "# Spec — Approved\n\n## Overview\n- Guided project spec.";
        const updated = [
          existing.trimEnd(),
          "",
          "## Verify",
          `- ${arg || "End-to-end test passes from intake through approval."}`,
          "",
        ].join("\n");
        writeFileSync(specPath, updated, "utf8");
        await say(client, sid, "Updated docs/SPEC.md with ## Verify section.");
        break;
      }
      case "revise-mock": {
        const docsDir = join(process.cwd(), "docs");
        mkdirSync(docsDir, { recursive: true });
        const mockPath = join(docsDir, "mock.html");
        const existing = existsSync(mockPath)
          ? readFileSync(mockPath, "utf8")
          : "<!DOCTYPE html><html><body><h1>Mock</h1></body></html>";
        const revisionText = arg || "Live revision";
        const updated = existing.includes("</body>")
          ? existing.replace("</body>", `  <p data-revision="true">${revisionText}</p>\n</body>`)
          : `${existing}\n<p data-revision="true">${revisionText}</p>`;
        writeFileSync(mockPath, updated, "utf8");
        await say(client, sid, `Revised docs/mock.html: ${revisionText}`);
        break;
      }
      default: {
        if (input.startsWith("[Cross-review]")) {
          if (input.includes("FAKE:write-and-stall")) {
            writeFileSync(join(process.cwd(), "tampered.txt"), "tampered and stalled\n", "utf8");
            const cancelled = await new Promise<boolean>((resolve) => {
              cancel = () => resolve(true);
            });
            cancel = null;
            if (cancelled) return { stopReason: "cancelled" as const };
            break;
          }

          if (input.includes("FAKE:write-file")) {
            writeFileSync(join(process.cwd(), "tampered.txt"), "tampered by fake agent\n", "utf8");
          }

          if (input.includes("FAKE:delete-git")) {
            const gitFile = join(process.cwd(), ".git");
            rmSync(gitFile, { recursive: true, force: true });
          }

          if (input.includes("FAKE:rewrite-git")) {
            const gitFile = join(process.cwd(), ".git");
            writeFileSync(gitFile, "gitdir: /tmp/fake-gitdir\n", "utf8");
          }

          if (input.includes("FAKE:write-common-hook")) {
            try {
              const commonDirRaw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
                cwd: process.cwd(),
                encoding: "utf8",
              }).trim();
              const commonDir = resolve(process.cwd(), commonDirRaw);
              const hooksDir = join(commonDir, "hooks");
              mkdirSync(hooksDir, { recursive: true });
              writeFileSync(join(hooksDir, "post-checkout"), "#!/bin/sh\necho pwned\n", "utf8");
            } catch {
              // ignore
            }
          }

          if (input.includes("FAKE:rewrite-commondir")) {
            try {
              const gitContent = readFileSync(join(process.cwd(), ".git"), "utf8");
              const m = gitContent.match(/^gitdir:\s*(.+)$/m);
              if (m) {
                const adminDir = resolve(process.cwd(), m[1]!.trim());
                writeFileSync(join(adminDir, "commondir"), "../fake-common\n", "utf8");
              }
            } catch {
              // ignore
            }
          }

          if (input.includes("FAKE:add-alternates")) {
            try {
              const commonDirRaw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
                cwd: process.cwd(),
                encoding: "utf8",
              }).trim();
              const commonDir = resolve(process.cwd(), commonDirRaw);
              const objInfoDir = join(commonDir, "objects", "info");
              mkdirSync(objInfoDir, { recursive: true });
              writeFileSync(join(objInfoDir, "alternates"), "/tmp/fake-objects\n", "utf8");
            } catch {
              // ignore
            }
          }

          if (input.includes("FAKE:ask-write")) {
            const editRes = (await client.request(acp.methods.client.session.requestPermission, {
              sessionId: sid,
              toolCall: { toolCallId: "tool-edit-1", title: "Write a file", kind: "edit", status: "pending" },
              options: [
                { optionId: "allow", name: "Allow once", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
            })) as acp.RequestPermissionResponse;
            const editOutcome = editRes.outcome.outcome === "cancelled" ? "cancelled" : editRes.outcome.optionId === "allow" ? "allowed" : "denied";

            const readRes = (await client.request(acp.methods.client.session.requestPermission, {
              sessionId: sid,
              toolCall: {
                toolCallId: "tool-read-1",
                title: "Read a file",
                kind: "read",
                locations: [{ path: join(process.cwd(), "README.md") }],
                status: "pending",
              },
              options: [
                { optionId: "allow", name: "Allow once", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
            })) as acp.RequestPermissionResponse;
            const readOutcome = readRes.outcome.outcome === "cancelled" ? "cancelled" : readRes.outcome.optionId === "allow" ? "allowed" : "denied";

            const findings = [
              {
                severity: "high",
                file: "README.md",
                line: 10,
                claim: "Write permission test claim",
                proof: `edit: ${editOutcome}, read: ${readOutcome}`,
              },
            ];
            await say(client, sid, `\`\`\`json\n${JSON.stringify({ findings }, null, 2)}\n\`\`\``);
            break;
          }

          if (input.includes("FAKE:bad-json")) {
            await say(client, sid, "I found some issues, but I am not outputting valid JSON block.");
            break;
          }

          const findings = [
            {
              severity: "high",
              file: "src/index.ts",
              line: 10,
              claim: "Missing input validation in auth check",
              proof: "No check on input length or shape.",
            },
            {
              severity: "medium",
              file: "src/utils.ts",
              line: 25,
              claim: "Possible null reference in helper function",
              proof: "Variable can be undefined when input is empty.",
            },
            {
              severity: "low",
              file: "README.md",
              line: null,
              claim: "Documentation refers to deprecated configuration option",
              proof: "Option was removed in previous milestone.",
            },
          ];
          await say(client, sid, `\`\`\`json\n${JSON.stringify({ findings }, null, 2)}\n\`\`\``);
          break;
        }

        if (input.startsWith("[Triage]")) {
          const matches = [...input.matchAll(/Finding\s+(\d+)/gi)].map((m) => parseInt(m[1]!, 10));
          const count = matches.length > 0 ? matches.length : 3;
          const triage = Array.from({ length: count }, (_, idx) => ({
            index: matches[idx] ?? idx,
            bucket: idx === 0 ? "must-fix" : idx === 1 ? "should-fix" : "nit",
            reason: idx === 0 ? "Critical security fix needed before merge." : idx === 1 ? "Important bug fix." : "Minor style issue.",
          }));
          await say(client, sid, `\`\`\`json\n${JSON.stringify({ triage }, null, 2)}\n\`\`\``);
          break;
        }

        if (input.startsWith("[Spec interview]")) {
          const docsDir = join(process.cwd(), "docs");
          mkdirSync(docsDir, { recursive: true });
          const intakePath = join(docsDir, "INTAKE.md");
          const intake = existsSync(intakePath) ? readFileSync(intakePath, "utf8") : input;
          const problemMatch = intake.match(/-\s+\*\*Problem:\*\*\s*(.+)/);
          const usersMatch = intake.match(/-\s+\*\*Users:\*\*\s*(.+)/);
          const constraintsMatch = intake.match(/-\s+\*\*Constraints:\*\*\s*(.+)/);
          const draft = [
            "# Spec",
            "",
            "Sections are linkable as `[[SPEC#<Heading>]]`.",
            "",
            "## Overview",
            `- Problem: ${problemMatch?.[1]?.trim() || "Defined in intake"}`,
            `- Target users: ${usersMatch?.[1]?.trim() || "Project users"}`,
            "",
            "## Architecture & Constraints",
            `- ${constraintsMatch?.[1]?.trim() || "Local-first TypeScript stack"}`,
            "",
          ].join("\n");
          writeFileSync(join(docsDir, "SPEC.md"), draft, "utf8");
          await say(
            client,
            sid,
            "I read docs/INTAKE.md and wrote an initial draft of docs/SPEC.md. Before we finalize, what end-to-end checks should go into the ## Verify section?",
          );
          break;
        }
        if (input.startsWith("[Mock build]")) {
          const docsDir = join(process.cwd(), "docs");
          mkdirSync(docsDir, { recursive: true });
          const specPath = join(docsDir, "SPEC.md");
          const spec = existsSync(specPath) ? readFileSync(specPath, "utf8") : input;
          const overview = spec.match(/## Overview[\s\S]*?(?=\n##|$)/)?.[0]?.trim() || "Built from docs/SPEC.md";
          const mockContent = [
            "<!DOCTYPE html>",
            "<html lang=\"en\">",
            "<head>",
            "  <meta charset=\"UTF-8\">",
            "  <title>Mock</title>",
            "  <style>",
            "    body { font-family: sans-serif; padding: 24px; background: #fafafa; color: #111; }",
            "    .btn { padding: 8px 16px; background: #2563eb; color: #fff; border: none; border-radius: 6px; cursor: pointer; }",
            "    .box { margin-top: 16px; padding: 16px; background: #fff; border: 1px solid #ddd; border-radius: 8px; }",
            "  </style>",
            "</head>",
            "<body>",
            "  <h1>Clickable Mock</h1>",
            `  <p>${overview}</p>`,
            "  <button id=\"mock-btn\" class=\"btn\" onclick=\"document.getElementById('status').innerText = 'Clicked!'\">Click me</button>",
            "  <div class=\"box\" id=\"status\">Initial mock state</div>",
            "</body>",
            "</html>",
          ].join("\n");
          writeFileSync(join(docsDir, "mock.html"), mockContent, "utf8");
          await say(
            client,
            sid,
            "Built clickable HTML mock in docs/mock.html. Ask for revisions in chat or publish and approve when ready.",
          );
          break;
        }
        if (input.startsWith("[Plan generation]")) {
          const docsDir = join(process.cwd(), "docs");
          mkdirSync(docsDir, { recursive: true });
          const planContent = [
            "# Plan",
            "",
            "Status legend: `[ ]` todo · `[~]` in progress · `[x]` done.",
            "",
            "## M1 — v1.0 Initial Release",
            "",
            "Done when: the core workflow from docs/SPEC.md passes end-to-end verification.",
            "",
            "- [ ] **T1.1 Core implementation** `[claude]` — [[SPEC#Overview]]",
            "  Implement the core project workflow described in the spec.",
            "  check: `pnpm test`",
            "- [ ] **T1.2 End-to-end verification** `[gemini]` — [[SPEC#Verify]]",
            "  Add end-to-end verification tests covering the Verify section.",
            "  check: `pnpm test:e2e`",
            "",
          ].join("\n");
          writeFileSync(join(docsDir, "PLAN.md"), planContent, "utf8");
          await say(
            client,
            sid,
            "Generated docs/PLAN.md grouped into milestones with Done when UAT items and tasks. Ask for changes or click Approve plan.",
          );
          break;
        }
        const docsDir = join(process.cwd(), "docs");
        const planPath = join(docsDir, "PLAN.md");
        if (
          existsSync(planPath) &&
          !readFileSync(planPath, "utf8").includes("check: `<command that passes when this is done>`")
        ) {
          const revisionText = input.trim();
          const existing = readFileSync(planPath, "utf8").trimEnd();
          const updated = [
            existing,
            `- [ ] **T1.3 ${revisionText}** \`[claude]\` — [[SPEC#Verify]]`,
            `  ${revisionText}`,
            "  check: `pnpm test`",
            "",
          ].join("\n");
          writeFileSync(planPath, updated, "utf8");
          await say(client, sid, `Updated docs/PLAN.md: ${revisionText}`);
          break;
        }
        const mockPath = join(docsDir, "mock.html");
        if (existsSync(mockPath)) {
          const revisionText = input.trim();
          const existing = readFileSync(mockPath, "utf8");
          const updated = existing.includes("</body>")
            ? existing.replace("</body>", `  <p data-revision="true">${revisionText}</p>\n</body>`)
            : `${existing}\n<p data-revision="true">${revisionText}</p>`;
          writeFileSync(mockPath, updated, "utf8");
          await say(client, sid, `Revised docs/mock.html: ${revisionText}`);
          break;
        }
        const specPath = join(docsDir, "SPEC.md");
        if (existsSync(specPath)) {
          const existing = readFileSync(specPath, "utf8").replace(/\n*##\s+Verify[\s\S]*$/i, "");
          const updated = [
            existing.trimEnd(),
            "",
            "## Verify",
            `- ${input.trim()}`,
            "",
          ].join("\n");
          writeFileSync(specPath, updated, "utf8");
          await say(client, sid, `Added ## Verify section to docs/SPEC.md: ${input.trim()}`);
          break;
        }
        await say(client, sid, `unknown: ${input}`);
      }
    }
    return { stopReason: "end_turn" as const };
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
await app.connect(stream).closed;
process.exit(0);
