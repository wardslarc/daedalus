CREATE TABLE `uat_replay_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`script_id` integer NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`trace_path` text,
	`duration_ms` integer,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `uat_replay_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`script_id`) REFERENCES `uat_scripts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "uat_replay_results_status_check" CHECK("uat_replay_results"."status" in ('passed', 'failed', 'error'))
);
--> statement-breakpoint
CREATE TABLE `uat_replay_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`session_id` text,
	`release_version` text NOT NULL,
	`head_sha` text NOT NULL,
	`kind` text DEFAULT 'full' NOT NULL,
	`status` text NOT NULL,
	`total_scripts` integer DEFAULT 0 NOT NULL,
	`passed_scripts` integer DEFAULT 0 NOT NULL,
	`failed_scripts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `uat_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "uat_replay_runs_kind_check" CHECK("uat_replay_runs"."kind" in ('full', 'single')),
	CONSTRAINT "uat_replay_runs_status_check" CHECK("uat_replay_runs"."status" in ('running', 'passed', 'failed', 'error'))
);
--> statement-breakpoint
CREATE TABLE `uat_scripts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`item_id` integer,
	`item_text` text NOT NULL,
	`release_version` text NOT NULL,
	`recorded_origin` text NOT NULL,
	`head_sha` text NOT NULL,
	`session_id` text,
	`script_text` text NOT NULL,
	`sha256` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`retired_reason` text,
	`replaced_by` integer,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `uat_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `uat_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`replaced_by`) REFERENCES `uat_scripts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "uat_scripts_status_check" CHECK("uat_scripts"."status" in ('draft', 'active', 'retired'))
);
