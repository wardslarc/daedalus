/**
 * Process-wide services, read by Next.js route handlers. Built once by server.ts (see
 * init-services.ts), which runs under tsx and loads the workspace packages directly.
 * This file has only type imports, so Next.js never bundles those packages; route
 * handlers reach them through this object on globalThis (Symbol.for key, so it also
 * survives Next's dev reloads).
 */
import type { DaedalusDb, gateFindings, projects, tasks } from "@daedalus/db";
import type { ApproveMockInput, ApprovePlanInput, ApproveSpecInput, BrowseResult, CreateInput, createProject, ImportInput, importProject, mergeKit, MilestoneState, MockApproval, ParsedMilestone, PipelineTask, ReleaseGateData, ReviewData, RunTaskResult, SaveIntakeInput, ShapingState, StartMilestoneInput, TaskRunner } from "@daedalus/projects";
import type { ProfileRules } from "@daedalus/core/profiles";
import type { TaskStatus } from "@daedalus/core/task-state";
import type { ProviderEntry, SessionManager } from "@daedalus/providers";
import type { SessionInfo, TerminalInfo } from "./ws/protocol.js";
import type { TerminalManager } from "./terminal.js";

export type ProjectWithKit = typeof projects.$inferSelect & {
  kitPending: boolean;
};

export type ProjectChatInfo = ShapingState & {
  project: typeof projects.$inferSelect;
  rules: ProfileRules & { effectiveGemini: boolean };
};

export type PipelineStage = "Intake" | "Spec" | "Mock" | "Plan" | "Build" | "Review" | "Verify" | "Ship";

export type EnrichedPipelineTask = PipelineTask & {
  lastCheckOutput?: string | null;
  runnable?: boolean;
  disabledReason?: string | null;
};

export type ProjectPipelineInfo = {
  project: typeof projects.$inferSelect;
  rules: ProfileRules & { effectiveGemini: boolean };
  stage: PipelineStage;
  activeMilestone: MilestoneState | null;
  milestones: ParsedMilestone[];
  tasks: EnrichedPipelineTask[];
  runningTasksCount?: number;
};

export type UpdateSettingsInput = {
  profile: string;
  geminiAllowed?: unknown;
};

export type Services = SessionServices & {
  db: DaedalusDb;
  dataDir: string;
  repoRoot: string;
  /** Validated providers.json: the only agents Daedalus may launch (T3.1). */
  providers: readonly ProviderEntry[];
  /** Running agent sessions (T3.2); stopped by closeServices on shutdown. */
  sessions: SessionManager;
  importProject(input: ImportInput): ReturnType<typeof importProject>;
  createProject(input: CreateInput): ReturnType<typeof createProject>;
  listProjects(): Promise<ProjectWithKit[]>;
  /** Browse folders on the server (WSL filesystem and /mnt/* drives) for the Import dialog. */
  browseFolders(opts?: { path?: string; showHidden?: boolean }): BrowseResult;
  /** Merge daedalus/kit into the project's default branch (T2.9). 404 if no such project. */
  mergeKit(projectId: number): ReturnType<typeof mergeKit>;
  /** Update project settings (T2.7). 404 if no such project. Stops agents the new settings forbid. */
  updateProjectSettings(
    id: number,
    input: UpdateSettingsInput,
  ): Promise<{ project: typeof projects.$inferSelect; stoppedSessions: string[] }>;
  /** Get project chat info, profile rules and shaping state (T4.1). 404 if no such project. */
  getProjectChat(projectId: number): Promise<ProjectChatInfo>;
  /** Save docs/INTAKE.md safely into project docs/ (T4.1). 404 if no such project. */
  saveIntake(projectId: number, input: SaveIntakeInput): Promise<ShapingState & { ok: true; content: string }>;
  /** Start or resume the guided Claude Spec interview session for a project (T4.2). 404 if no such project. */
  startSpecInterview(projectId: number): Promise<{ session: SessionInfo; prompt: string; state: ShapingState }>;
  /** Validate and approve docs/SPEC.md (requires ## Verify) to advance to Mock (T4.2). 404 if no such project. */
  approveSpec(projectId: number, input?: ApproveSpecInput): Promise<ShapingState & { ok: true; content: string }>;
  /** Start or resume the Mock session with the chosen provider (T4.3). 404 if no such project; 403 profile rules. */
  startMockSession(
    projectId: number,
    providerId: string,
  ): Promise<{ session: SessionInfo; prompt: string; state: ShapingState }>;
  /** Validate and approve docs/mock.html with published artifact link and approver (T4.3). 404 if no such project. */
  approveMock(
    projectId: number,
    input: ApproveMockInput,
  ): Promise<ShapingState & { ok: true; approval: MockApproval }>;
  /** Start or resume the Claude Plan generation session for a project (T4.4). 404 if no such project. */
  startPlanSession(projectId: number): Promise<{ session: SessionInfo; prompt: string; state: ShapingState }>;
  /** Validate and save/approve docs/PLAN.md (T4.4). 404 if no such project. */
  approvePlan(
    projectId: number,
    input?: ApprovePlanInput,
  ): Promise<ShapingState & { ok: true; content: string }>;
  /** Start a milestone: create release branch daedalus/release-<version> from defaultBranch and freeze scope (T4.4). */
  startMilestone(
    projectId: number,
    input?: StartMilestoneInput,
  ): Promise<ShapingState & { ok: true; milestone: MilestoneState }>;
  /** Get project pipeline, milestone tasks, and stage (T5.1). 404 if no such project. */
  getProjectPipeline(projectId: number): Promise<ProjectPipelineInfo>;
  /** Run a task in an isolated worktree with automated check execution (T5.3). */
  runTask(projectId: number, taskCode: string): Promise<RunTaskResult>;
  /** List running tasks across all projects (T5.3). */
  listRunning(): Array<{ projectId: number; taskCode: string; taskId: number }>;
  /** Task runner instance (T5.3). */
  runner: TaskRunner;
  /** Get review data for a task (T6.1). 404 if no such project or task. */
  getReview(projectId: number, taskCode: string): Promise<ReviewData>;
  /** List all in-review tasks for a project (T6.1). 404 if no such project. */
  listInReviewTasks(projectId: number): Promise<Array<typeof tasks.$inferSelect>>;
  /** Approve task into release branch (T6.1). */
  approveTask(projectId: number, taskCode: string, headSha: string): Promise<{ sha: string; status: TaskStatus }>;
  /** Send back task with notes (T6.1). */
  sendBack(projectId: number, taskCode: string, notes: string, headSha: string): Promise<{ status: TaskStatus }>;
  /** Discard task, delete branch and worktree, clear notes (T6.1). */
  discardTask(projectId: number, taskCode: string, headSha: string): Promise<{ status: TaskStatus }>;
  /** Acknowledge a needs-ack gate (T6.1). */
  ackGate(
    projectId: number,
    taskCode: string,
    gateId: string,
    note: string,
    headSha: string,
    fingerprint: string,
  ): Promise<{ gate: string; note: string; ackedAt: string; headSha?: string | null; itemsSha256?: string | null }>;
  /** Start a cross-review on an in-review task (T6.2). */
  startCrossReview(projectId: number, taskCode: string): Promise<{ reviewId: number }>;
  /** Get release gate status, checks, findings, and ship checklist (T6.3). */
  getReleaseGate(projectId: number): Promise<ReleaseGateData>;
  /** Start a background gate run (T6.3). 409 if verify not started or already running. */
  startGateRun(projectId: number): Promise<{ runId: number }>;
  /** Decide an outcome for a gate finding (fix-task, accept, defer) (T6.3). */
  decideFinding(
    projectId: number,
    findingId: number,
    input: { outcome: string; reason?: string; checkCommand?: string },
  ): Promise<{ finding: typeof gateFindings.$inferSelect; task?: typeof tasks.$inferSelect }>;
  /** Toggle or set a ship checklist item (T6.3). */
  setChecklistItem(
    projectId: number,
    itemId: string,
    ticked: boolean,
  ): Promise<{ itemId: string; ticked: boolean }>;
};

export type SessionServices = {
  /** Start an agent on a project from the database (T3.3). 404 no project; 403 profile rules; 409 full. */
  startSession(projectId: number, providerId: string): Promise<SessionInfo>;
  listSessions(): SessionInfo[];
  /** 404 if no such session. */
  stopSession(id: string): Promise<void>;
  /** Free terminals (T3.7). */
  terminals: TerminalManager;
  /** Open a shell in a project folder from the database. 404 no project or folder; 409 two open. */
  openTerminal(projectId: number): Promise<TerminalInfo>;
  listTerminals(): TerminalInfo[];
  /** 404 if no such terminal. */
  closeTerminal(id: string): Promise<void>;
};

export const SERVICES_KEY = Symbol.for("daedalus.services");
export type ServicesHolder = { [SERVICES_KEY]?: Services };

export function getServices(): Services {
  const services = (globalThis as ServicesHolder)[SERVICES_KEY];
  if (!services) throw new Error("Daedalus services are not initialised: start the app with `pnpm dae`.");
  return services;
}
