import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  localPath: text("local_path").notNull().unique(),
  profile: text("profile", { enum: ["work", "client", "personal"] }).notNull(),
  gitHost: text("git_host"),
  gitRemote: text("git_remote"),
  defaultBranch: text("default_branch").notNull().default("main"),
  geminiAllowed: integer("gemini_allowed", { mode: "boolean" })
    .notNull()
    .default(false),
  origin: text("origin", { enum: ["imported", "created"] })
    .notNull()
    .default("imported"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
},
(table) => [
  check("projects_profile_check", sql`${table.profile} in ('work', 'client', 'personal')`),
]);

export const providers = sqliteTable(
  "providers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull().unique(),
    kind: text("kind", { enum: ["acp", "cli"] }).notNull(),
    launchCommand: text("launch_command").notNull(),
    roles: text("roles", { mode: "json" }).$type<string[]>().notNull(),
    allowedProfiles: text("allowed_profiles", { mode: "json" })
      .$type<string[]>()
      .notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    check("providers_kind_check", sql`${table.kind} in ('acp', 'cli')`),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    title: text("title").notNull(),
    tag: text("tag"),
    checkCommand: text("check_command"),
    status: text("status").notNull().default("queued"),
    linkedSpecSections: text("linked_spec_sections", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    attempts: integer("attempts").notNull().default(0),
    branch: text("branch"),
    frozenAt: text("frozen_at"),
    milestoneCode: text("milestone_code"),
    reviewNotes: text("review_notes"),
    description: text("description"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    unique("tasks_project_id_code_unique").on(table.projectId, table.code),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    providerId: integer("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    role: text("role", { enum: ["implement", "review", "chat"] }).notNull(),
    start: text("start")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    end: text("end"),
    exitStatus: integer("exit_status"),
    logPath: text("log_path"),
    usageEstimate: text("usage_estimate", { mode: "json" }),
    checkExitCode: integer("check_exit_code"),
    checkOutput: text("check_output"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    check(
      "runs_role_check",
      sql`${table.role} in ('implement', 'review', 'chat')`,
    ),
  ],
);

export const reviews = sqliteTable("reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  reviewer: text("reviewer").notNull(),
  status: text("status").notNull().default("running"),
  headSha: text("head_sha"),
  findings: text("findings").notNull(),
  claudeTriage: text("claude_triage"),
  ownerDecision: text("owner_decision"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  error: text("error"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export const reviewAcks = sqliteTable(
  "review_acks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    gate: text("gate").notNull(),
    ackedAt: text("acked_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    note: text("note").notNull(),
    headSha: text("head_sha"),
    itemsSha256: text("items_sha256"),
  },
  (table) => [
    unique("review_acks_task_id_gate_unique").on(table.taskId, table.gate),
  ],
);


export const usage = sqliteTable(
  "usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    providerId: integer("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    week: text("week").notNull(),
    amountUsed: integer("amount_used").notNull().default(0),
    limit: integer("limit"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    unique("usage_provider_id_week_unique").on(table.providerId, table.week),
  ],
);

export const inbox = sqliteTable(
  "inbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["review", "approval", "failed_check", "quota"],
    }).notNull(),
    link: text("link").notNull(),
    read: integer("read", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    check(
      "inbox_kind_check",
      sql`${table.kind} in ('review', 'approval', 'failed_check', 'quota')`,
    ),
  ],
);

export const docNodes = sqliteTable("doc_nodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  heading: text("heading"),
  slug: text("slug"),
  content: text("content"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export const docLinks = sqliteTable("doc_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceNodeId: integer("source_node_id")
    .notNull()
    .references(() => docNodes.id, { onDelete: "cascade" }),
  targetNodeId: integer("target_node_id").references(() => docNodes.id, {
    onDelete: "set null",
  }),
  rawTarget: text("raw_target").notNull(),
  isEmbed: integer("is_embed", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export const shapingState = sqliteTable("shaping_state", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: "cascade" }),
  intakeCompletedAt: text("intake_completed_at"),
  specApprovedAt: text("spec_approved_at"),
  mockProviderId: text("mock_provider_id"),
  mockArtifactUrl: text("mock_artifact_url"),
  mockApprovedBy: text("mock_approved_by"),
  mockApprovedAt: text("mock_approved_at"),
  planApprovedAt: text("plan_approved_at"),
  planApprovedSha256: text("plan_approved_sha256"),
  activeMilestoneVersion: text("active_milestone_version"),
  activeMilestoneCode: text("active_milestone_code"),
  activeMilestoneBranch: text("active_milestone_branch"),
  activeMilestoneStartedAt: text("active_milestone_started_at"),
  activeMilestoneFrozen: integer("active_milestone_frozen", { mode: "boolean" }),
  activeMilestoneVerifyStartedAt: text("active_milestone_verify_started_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export type GateCheckStatus = "pass" | "fail" | "error" | "not-applicable";

export type GateCheckResult = {
  status: GateCheckStatus;
  detail?: string;
};

export type GateRunChecks = {
  secrets?: GateCheckResult;
  dependencies?: GateCheckResult;
  securityTests?: GateCheckResult;
  checklist?: GateCheckResult;
  uat?: GateCheckResult;
};

export const gateRuns = sqliteTable(
  "gate_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    releaseVersion: text("release_version").notNull(),
    headSha: text("head_sha").notNull(),
    defaultSha: text("default_sha"),
    status: text("status", { enum: ["running", "done", "error"] }).notNull(),
    checks: text("checks", { mode: "json" }).$type<GateRunChecks>(),
    error: text("error"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    finishedAt: text("finished_at"),
  },
  (table) => [
    check(
      "gate_runs_status_check",
      sql`${table.status} in ('running', 'done', 'error')`,
    ),
  ],
);

export const gateFindings = sqliteTable(
  "gate_findings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    releaseVersion: text("release_version").notNull(),
    check: text("check", {
      enum: ["secrets", "dependencies", "security-tests", "uat"],
    }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    severity: text("severity", {
      enum: ["critical", "high", "moderate", "low"],
    }).notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    location: text("location"),
    blocking: integer("blocking", { mode: "boolean" }).notNull(),
    state: text("state", { enum: ["open", "resolved"] })
      .notNull()
      .default("open"),
    outcome: text("outcome", { enum: ["fix-task", "accept", "defer", "change-request"] }),
    reason: text("reason"),
    fixTaskId: integer("fix_task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    decidedAt: text("decided_at"),
    firstSeenRunId: integer("first_seen_run_id").references(() => gateRuns.id, {
      onDelete: "set null",
    }),
    lastSeenRunId: integer("last_seen_run_id").references(() => gateRuns.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    check(
      "gate_findings_check_check",
      sql`${table.check} in ('secrets', 'dependencies', 'security-tests', 'uat')`,
    ),
    check(
      "gate_findings_severity_check",
      sql`${table.severity} in ('critical', 'high', 'moderate', 'low')`,
    ),
    check(
      "gate_findings_state_check",
      sql`${table.state} in ('open', 'resolved')`,
    ),
    check(
      "gate_findings_outcome_check",
      sql`${table.outcome} is null or ${table.outcome} in ('fix-task', 'accept', 'defer', 'change-request')`,
    ),
    unique("gate_findings_project_id_release_version_fingerprint_unique").on(
      table.projectId,
      table.releaseVersion,
      table.fingerprint,
    ),
  ],
);

export const securityTests = sqliteTable("security_tests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  path: text("path").notNull(),
  sha256: text("sha256").notNull(),
  command: text("command").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export const shipChecklistTicks = sqliteTable(
  "ship_checklist_ticks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    releaseVersion: text("release_version").notNull(),
    itemId: text("item_id").notNull(),
    tickedAt: text("ticked_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    unique("ship_checklist_ticks_project_id_release_version_item_id_unique").on(
      table.projectId,
      table.releaseVersion,
      table.itemId,
    ),
  ],
);

export const uatItems = sqliteTable(
  "uat_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    releaseVersion: text("release_version").notNull(),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    source: text("source", { enum: ["plan", "spec"] }).notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    check("uat_items_source_check", sql`${table.source} in ('plan', 'spec')`),
    unique("uat_items_project_id_release_version_position_unique").on(
      table.projectId,
      table.releaseVersion,
      table.position,
    ),
  ],
);

export const uatMarks = sqliteTable(
  "uat_marks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id")
      .notNull()
      .references(() => uatItems.id, { onDelete: "cascade" }),
    result: text("result", { enum: ["pass", "fail"] }).notNull(),
    note: text("note"),
    kind: text("kind", { enum: ["bug", "change"] }),
    headSha: text("head_sha").notNull(),
    sessionId: text("session_id"),
    fixTaskId: integer("fix_task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    findingId: integer("finding_id").references(() => gateFindings.id, {
      onDelete: "set null",
    }),
    markedAt: text("marked_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    check("uat_marks_result_check", sql`${table.result} in ('pass', 'fail')`),
    check("uat_marks_kind_check", sql`${table.kind} is null or ${table.kind} in ('bug', 'change')`),
  ],
);

export const uatAppConfig = sqliteTable("uat_app_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: "cascade" }),
  startCommand: text("start_command").notNull(),
  appUrl: text("app_url").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export const uatSessions = sqliteTable(
  "uat_sessions",
  {
    id: text("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    releaseVersion: text("release_version").notNull(),
    headSha: text("head_sha").notNull(),
    status: text("status", {
      enum: ["starting", "running", "stopped", "error"],
    }).notNull(),
    error: text("error"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    endedAt: text("ended_at"),
  },
  (table) => [
    check(
      "uat_sessions_status_check",
      sql`${table.status} in ('starting', 'running', 'stopped', 'error')`,
    ),
    uniqueIndex("uat_sessions_active_project_unique")
      .on(table.projectId)
      .where(sql`${table.status} in ('starting', 'running')`),
  ],
);

export const uatScripts = sqliteTable(
  "uat_scripts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    itemId: integer("item_id").references(() => uatItems.id, {
      onDelete: "set null",
    }),
    itemText: text("item_text").notNull(),
    releaseVersion: text("release_version").notNull(),
    recordedOrigin: text("recorded_origin").notNull(),
    headSha: text("head_sha").notNull(),
    sessionId: text("session_id").references(() => uatSessions.id, {
      onDelete: "set null",
    }),
    scriptText: text("script_text").notNull(),
    sha256: text("sha256").notNull(),
    status: text("status", { enum: ["draft", "active", "retired"] })
      .notNull()
      .default("draft"),
    retiredReason: text("retired_reason"),
    replacedBy: integer("replaced_by"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    check(
      "uat_scripts_status_check",
      sql`${table.status} in ('draft', 'active', 'retired')`,
    ),
    foreignKey({
      name: "uat_scripts_replaced_by_fk",
      columns: [table.replacedBy],
      foreignColumns: [table.id],
    }).onDelete("set null"),
  ],
);

export const uatReplayRuns = sqliteTable(
  "uat_replay_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => uatSessions.id, {
      onDelete: "set null",
    }),
    releaseVersion: text("release_version").notNull(),
    headSha: text("head_sha").notNull(),
    kind: text("kind", { enum: ["full", "single"] })
      .notNull()
      .default("full"),
    status: text("status", {
      enum: ["running", "passed", "failed", "error"],
    }).notNull(),
    totalScripts: integer("total_scripts").notNull().default(0),
    passedScripts: integer("passed_scripts").notNull().default(0),
    failedScripts: integer("failed_scripts").notNull().default(0),
    error: text("error"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    finishedAt: text("finished_at"),
  },
  (table) => [
    check(
      "uat_replay_runs_kind_check",
      sql`${table.kind} in ('full', 'single')`,
    ),
    check(
      "uat_replay_runs_status_check",
      sql`${table.status} in ('running', 'passed', 'failed', 'error')`,
    ),
  ],
);

export const uatReplayResults = sqliteTable(
  "uat_replay_results",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: integer("run_id")
      .notNull()
      .references(() => uatReplayRuns.id, { onDelete: "cascade" }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scriptId: integer("script_id")
      .notNull()
      .references(() => uatScripts.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["passed", "failed", "error"] }).notNull(),
    detail: text("detail"),
    tracePath: text("trace_path"),
    durationMs: integer("duration_ms"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
  },
  (table) => [
    check(
      "uat_replay_results_status_check",
      sql`${table.status} in ('passed', 'failed', 'error')`,
    ),
  ],
);



