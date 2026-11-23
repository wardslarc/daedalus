import { sql } from "drizzle-orm";
import {
  check,
  integer,
  sqliteTable,
  text,
  unique,
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
  findings: text("findings").notNull(),
  claudeTriage: text("claude_triage"),
  ownerDecision: text("owner_decision"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

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
