/**
 * ACP session manager (T3.2, SPEC#Providers, SPEC#Profiles). Starts an agent from the
 * provider registry in a project folder, streams its updates as typed events, passes its
 * permission requests to the owner (never auto-approved) and kills it, children included.
 * Grows out of the M0 spike (spikes/acp-spike.ts). No HTTP here: T3.3 forwards the events.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { assertProviderAllowed } from "@daedalus/core/profiles";
import type { ProviderEntry } from "./registry.js";

/** HTTP-shaped refusal; T3.3 answers with `status` and shows `message` to the owner. */
export class SessionError extends Error {
  override name = "SessionError";
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 502 = 400,
  ) {
    super(message);
  }
}

/** The fields of a project row a session needs. */
export type SessionProject = { id: number; name: string; localPath: string; profile: string; geminiAllowed: boolean };

export type PermissionOption = { optionId: string; name: string; kind: acp.PermissionOptionKind };

type EventBody =
  | { type: "prompt"; text: string }
  | { type: "message"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool_call"; toolCallId: string; title: string; kind?: string; status?: string }
  | { type: "tool_call_update"; toolCallId: string; title?: string; status?: string }
  | { type: "plan"; entries: { content: string; status: string; priority: string }[] }
  | { type: "usage"; used: number; size: number; cost?: { amount: number; currency: string } }
  | { type: "permission"; requestId: string; title: string; toolKind?: string; options: PermissionOption[] }
  | { type: "permission_resolved"; requestId: string; outcome: "selected" | "cancelled"; optionId?: string }
  | { type: "turn_end"; stopReason: string }
  | { type: "stderr"; text: string }
  | { type: "error"; message: string }
  | { type: "exit"; code: number | null; signal: string | null };

/** What a session emits. `seq` increases by one per event, for catching up after a reconnect. */
export type AgentEvent = EventBody & { seq: number; at: string };

export type SessionManagerOptions = {
  providers: readonly ProviderEntry[];
  /** Installed version of a provider (non-npx). Default: `<command> --version`. */
  checkVersion?: (provider: ProviderEntry) => Promise<string>;
  /** Unanswered permission requests are cancelled after this. Default 10 minutes. */
  permissionTimeoutMs?: number;
  /** Events kept for reconnecting viewers. Default 2,000. */
  backlogLimit?: number;
  /** Sessions running at once. Default 2 (the Build Plan's slots). */
  maxSessions?: number;
  /** Time between SIGTERM and SIGKILL on stop. Default 3 s. */
  killGraceMs?: number;
  /** Time allowed for initialize + session/new. Default 60 s. */
  startTimeoutMs?: number;
};

// A blocklist, not an allowlist (ADR 0010): agents need PATH, nvm, XDG and WSL variables we
// can't list ahead of time. AUTH also covers SSH_AUTH_SOCK: agents don't push, Daedalus does.
const SECRET_NAME = /TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|(^|_)(API_?)?KEY($|_)|APIKEY|PRIVATE|(^|_)PAT($|_)/i;
/** Credentials inside a URL value, e.g. postgres://user:pass@host. */
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;

/** The agent's environment: ours minus Daedalus's settings and anything that looks like a secret. */
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name.startsWith("DAE_") || SECRET_NAME.test(name) || URL_USERINFO.test(value)) continue;
    out[name] = value;
  }
  return out;
}

// Cast only: Next.js types make NODE_ENV a required key of ProcessEnv.
const agentEnv = () => scrubEnv(process.env) as NodeJS.ProcessEnv;

function defaultCheckVersion(provider: ProviderEntry): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(provider.command, ["--version"], { timeout: 10_000, env: agentEnv(), shell: false }, (err, stdout, stderr) => {
      if (err) return reject(new SessionError(`Couldn't run "${provider.command} --version": ${err.message}`, 502));
      const found = /\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?/.exec(`${stdout}\n${stderr}`);
      if (!found) return reject(new SessionError(`"${provider.command} --version" printed no version`, 502));
      resolve(found[0]);
    });
  });
}

// Process groups of every running agent, killed outright if the server exits without
// stopping them (a crash, or process.exit before stopAll finished).
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const g of liveGroups) killGroup(g, "SIGKILL");
  });
}
function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
}

type PendingPermission = {
  options: PermissionOption[];
  resolve: (outcome: acp.RequestPermissionOutcome) => void;
};

export class AgentSession {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  private readonly events: AgentEvent[] = [];
  private readonly pending = new Map<string, PendingPermission>();
  private seq = 0;
  private permissionSeq = 0;
  private busy = false;
  private ended = false;
  private stopping: Promise<void> | null = null;
  private acpSessionId = "";
  private connection: acp.ClientConnection | null = null;
  readonly exited: Promise<void>;

  constructor(
    readonly project: SessionProject,
    readonly providerId: string,
    private readonly child: ChildProcess,
    private readonly opts: Required<Pick<SessionManagerOptions, "permissionTimeoutMs" | "backlogLimit" | "killGraceMs">>,
    private readonly onEnd: (s: AgentSession) => void,
  ) {
    this.exited = new Promise((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: string | null) => {
        if (done) return;
        done = true;
        if (child.pid) liveGroups.delete(child.pid);
        this.end();
        // Anything left in the agent's group outlived it: kill it now.
        if (child.pid) killGroup(child.pid, "SIGKILL");
        this.emit({ type: "exit", code, signal });
        resolve();
      };
      child.once("exit", finish);
      child.once("error", (err) => {
        this.emit({ type: "error", message: `Agent process: ${err.message}` });
        // A program that never started (ENOENT, EACCES) sends no "exit".
        if (child.pid === undefined) finish(null, null);
      });
    });
    child.stderr?.setEncoding("utf8").on("data", (text: string) => this.emit({ type: "stderr", text }));
  }

  /** Open the ACP connection: initialize, then session/new in the project folder. */
  async open(folder: string, timeoutMs: number): Promise<void> {
    const { stdin, stdout } = this.child;
    if (!stdin || !stdout) throw new SessionError("Agent process has no stdio", 502);
    const stream = acp.ndJsonStream(Writable.toWeb(stdin) as WritableStream<Uint8Array>, Readable.toWeb(stdout) as ReadableStream<Uint8Array>);
    const app = acp
      .client({ name: "daedalus" })
      .onNotification(acp.methods.client.session.update, ({ params }) => this.onUpdate(params.update))
      .onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) => this.askOwner(params, signal));
    const conn = app.connect(stream);
    this.connection = conn;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SessionError(`The agent didn't start within ${Math.round(timeoutMs / 1000)} s`, 502)), timeoutMs);
    });
    const exited = this.exited.then(() => {
      throw new SessionError("The agent exited while starting", 502);
    });
    try {
      await Promise.race([
        (async () => {
          await conn.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            // Agents use their own tools (as in M0): no client file system or terminal.
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          });
          const session = await conn.agent.request(acp.methods.agent.session.new, { cwd: folder, mcpServers: [] });
          this.acpSessionId = session.sessionId;
        })(),
        timeout,
        exited,
      ]);
    } finally {
      clearTimeout(timer);
      exited.catch(() => undefined);
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return !this.ended;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Listen to new events. Returns a function that stops listening. */
  onEvent(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The last events (at most `backlogLimit`), oldest first. */
  backlog(): readonly AgentEvent[] {
    return this.events;
  }

  /**
   * Send one prompt. Resolves with the stop reason when the turn ends, or "stopped" if the
   * session ends first. One prompt at a time: a second while busy is a 409.
   */
  async prompt(text: string): Promise<string> {
    this.assertLive();
    if (this.busy) throw new SessionError("The agent is still working on the last prompt.", 409);
    if (typeof text !== "string" || text.trim() === "") throw new SessionError("Type something to send.", 400);
    this.busy = true;
    this.emit({ type: "prompt", text });
    let stopReason: string;
    try {
      const result = await this.connection!.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.acpSessionId,
        prompt: [{ type: "text", text }],
      });
      stopReason = result.stopReason;
    } catch (err) {
      this.busy = false;
      if (this.ended || this.stopping) return "stopped";
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", message });
      throw new SessionError(`The agent failed: ${message}`, 502);
    }
    // Free the session before announcing the turn end, so a listener can prompt again.
    this.busy = false;
    this.emit({ type: "turn_end", stopReason });
    return stopReason;
  }

  /** Ask the agent to stop the current turn (it answers the prompt with "cancelled"). */
  async cancel(): Promise<void> {
    this.assertLive();
    for (const id of [...this.pending.keys()]) this.settle(id, { outcome: "cancelled" });
    await this.connection!.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.acpSessionId });
  }

  /** The owner's answer to a permission request: one of its option ids, or "cancel". */
  respondPermission(requestId: string, optionId: string): void {
    const p = this.pending.get(requestId);
    if (!p) throw new SessionError("That permission request is no longer open.", 404);
    if (optionId === "cancel") return this.settle(requestId, { outcome: "cancelled" });
    if (!p.options.some((o) => o.optionId === optionId)) throw new SessionError("That isn't one of the offered choices.", 400);
    this.settle(requestId, { outcome: "selected", optionId });
  }

  /** Stop the agent: pending permissions cancelled, SIGTERM to its group, SIGKILL after the grace. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      for (const id of [...this.pending.keys()]) this.settle(id, { outcome: "cancelled" });
      const pid = this.child.pid;
      if (pid && this.child.exitCode === null && this.child.signalCode === null) {
        killGroup(pid, "SIGTERM");
        let timer: NodeJS.Timeout | undefined;
        const grace = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            killGroup(pid, "SIGKILL");
            resolve();
          }, this.opts.killGraceMs);
        });
        await Promise.race([this.exited, grace]);
        clearTimeout(timer);
        await this.exited;
      }
      this.connection?.close();
      this.end();
    })();
    return this.stopping;
  }

  private assertLive(): void {
    if (this.ended || this.stopping) throw new SessionError("This session has ended. Start a new one.", 410);
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const id of [...this.pending.keys()]) this.settle(id, { outcome: "cancelled" });
    this.onEnd(this);
  }

  private emit(body: EventBody): void {
    const event = { ...body, seq: ++this.seq, at: new Date().toISOString() } as AgentEvent;
    this.events.push(event);
    if (this.events.length > this.opts.backlogLimit) this.events.splice(0, this.events.length - this.opts.backlogLimit);
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A broken listener must not stop the others or the agent.
      }
    }
  }

  private askOwner(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    if (this.ended || this.stopping) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const requestId = `perm-${++this.permissionSeq}`;
    const options = params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }));
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, { outcome: "cancelled" }), this.opts.permissionTimeoutMs);
      const onAbort = () => this.settle(requestId, { outcome: "cancelled" });
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(requestId, {
        options,
        resolve: (outcome) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve({ outcome });
        },
      });
      this.emit({
        type: "permission",
        requestId,
        title: params.toolCall.title ?? "Tool call",
        ...(params.toolCall.kind ? { toolKind: params.toolCall.kind } : {}),
        options,
      });
    });
  }

  private settle(requestId: string, outcome: acp.RequestPermissionOutcome): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    p.resolve(outcome);
    this.emit({
      type: "permission_resolved",
      requestId,
      outcome: outcome.outcome,
      ...(outcome.outcome === "selected" ? { optionId: outcome.optionId } : {}),
    });
  }

  private onUpdate(u: acp.SessionNotification["update"]): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") this.emit({ type: "message", text: u.content.text });
        break;
      case "agent_thought_chunk":
        if (u.content.type === "text") this.emit({ type: "thought", text: u.content.text });
        break;
      case "tool_call":
        this.emit({ type: "tool_call", toolCallId: u.toolCallId, title: u.title, ...(u.kind ? { kind: u.kind } : {}), ...(u.status ? { status: u.status } : {}) });
        break;
      case "tool_call_update":
        this.emit({ type: "tool_call_update", toolCallId: u.toolCallId, ...(u.title ? { title: u.title } : {}), ...(u.status ? { status: u.status } : {}) });
        break;
      case "plan":
        this.emit({ type: "plan", entries: u.entries.map((e) => ({ content: e.content, status: e.status, priority: e.priority })) });
        break;
      case "usage_update":
        this.emit({ type: "usage", used: u.used, size: u.size, ...(u.cost ? { cost: { amount: u.cost.amount, currency: u.cost.currency } } : {}) });
        break;
      default:
        break;
    }
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private starting = 0;
  private readonly versions = new Map<string, Promise<string>>();
  private readonly opts: Required<Omit<SessionManagerOptions, "providers">> & { providers: readonly ProviderEntry[] };

  constructor(options: SessionManagerOptions) {
    this.opts = {
      checkVersion: defaultCheckVersion,
      permissionTimeoutMs: 10 * 60_000,
      backlogLimit: 2000,
      maxSessions: 2,
      killGraceMs: 3000,
      startTimeoutMs: 60_000,
      ...options,
    };
  }

  /**
   * Start an agent on a project. Every check runs before a process exists; any refusal
   * throws (SessionError with a status, or ProfileRuleError → 403) and starts nothing.
   */
  async start(project: SessionProject, providerId: string): Promise<AgentSession> {
    const provider = this.opts.providers.find((p) => p.id === providerId);
    if (!provider) throw new SessionError(`No provider "${providerId}" in providers.json.`, 404);
    if (provider.kind !== "acp") throw new SessionError(`"${providerId}" isn't an ACP agent.`, 400);
    // The profile rules first: Work never gets Gemini, whatever the registry says (ADR 0008).
    assertProviderAllowed(project, providerId);
    if (!(provider.allowedProfiles as readonly string[]).includes(project.profile)) {
      throw new SessionError(`"${providerId}" isn't allowed on ${project.profile} projects (providers.json).`, 403);
    }
    let folder: string;
    try {
      folder = await realpath(project.localPath);
      if (!(await stat(folder)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new SessionError(`The project folder is missing: ${project.localPath}`, 404);
    }

    if (this.sessions.size + this.starting >= this.opts.maxSessions) {
      throw new SessionError(`${this.opts.maxSessions} sessions are already running. Stop one first.`, 409);
    }
    this.starting++;
    try {
      await this.assertPinnedVersion(provider);
      return await this.launch(project, provider, folder);
    } finally {
      this.starting--;
    }
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  list(): AgentSession[] {
    return [...this.sessions.values()];
  }

  /** Stop every session (server shutdown). Resolves when every agent is gone. */
  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((s) => s.stop()));
  }

  private async assertPinnedVersion(provider: ProviderEntry): Promise<void> {
    // npx entries are pinned by their package argument (checked by the registry).
    if (provider.command === "npx") return;
    let check = this.versions.get(provider.id);
    if (!check) {
      check = this.opts.checkVersion(provider);
      this.versions.set(provider.id, check);
      check.catch(() => this.versions.delete(provider.id));
    }
    const installed = await check;
    if (installed !== provider.version) {
      throw new SessionError(
        `${provider.id} is ${installed} but providers.json pins ${provider.version}. Install ${provider.version} or update the pin on purpose.`,
        409,
      );
    }
  }

  private async launch(project: SessionProject, provider: ProviderEntry, folder: string): Promise<AgentSession> {
    const child = spawn(provider.command, provider.args, {
      cwd: folder,
      env: agentEnv(),
      shell: false,
      // Its own process group, so stop() reaches the agent's children too.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid) trackGroup(child.pid);
    const session = new AgentSession(project, provider.id, child, this.opts, (s) => this.sessions.delete(s.id));
    try {
      await session.open(folder, this.opts.startTimeoutMs);
    } catch (err) {
      await session.stop();
      if (err instanceof SessionError) throw err;
      throw new SessionError(`Couldn't start ${provider.id}: ${err instanceof Error ? err.message : String(err)}`, 502);
    }
    if (!session.running) throw new SessionError(`${provider.id} exited while starting.`, 502);
    this.sessions.set(session.id, session);
    return session;
  }
}
