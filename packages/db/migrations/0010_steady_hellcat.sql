CREATE TABLE `uat_app_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`start_command` text NOT NULL,
	`app_url` text NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uat_app_config_project_id_unique` ON `uat_app_config` (`project_id`);--> statement-breakpoint
CREATE TABLE `uat_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`release_version` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "uat_items_source_check" CHECK("uat_items"."source" in ('plan', 'spec'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uat_items_project_id_release_version_position_unique` ON `uat_items` (`project_id`,`release_version`,`position`);--> statement-breakpoint
CREATE TABLE `uat_marks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`result` text NOT NULL,
	`note` text,
	`kind` text,
	`head_sha` text NOT NULL,
	`session_id` text,
	`fix_task_id` integer,
	`finding_id` integer,
	`marked_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `uat_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fix_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`finding_id`) REFERENCES `gate_findings`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "uat_marks_result_check" CHECK("uat_marks"."result" in ('pass', 'fail')),
	CONSTRAINT "uat_marks_kind_check" CHECK("uat_marks"."kind" is null or "uat_marks"."kind" in ('bug', 'change'))
);
--> statement-breakpoint
CREATE TABLE `uat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` integer NOT NULL,
	`release_version` text NOT NULL,
	`head_sha` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`started_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "uat_sessions_status_check" CHECK("uat_sessions"."status" in ('starting', 'running', 'stopped', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uat_sessions_active_project_unique` ON `uat_sessions` (`project_id`) WHERE "uat_sessions"."status" in ('starting', 'running');--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_gate_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`release_version` text NOT NULL,
	`check` text NOT NULL,
	`fingerprint` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`location` text,
	`blocking` integer NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`outcome` text,
	`reason` text,
	`fix_task_id` integer,
	`decided_at` text,
	`first_seen_run_id` integer,
	`last_seen_run_id` integer,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fix_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`first_seen_run_id`) REFERENCES `gate_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`last_seen_run_id`) REFERENCES `gate_runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "gate_findings_check_check" CHECK("__new_gate_findings"."check" in ('secrets', 'dependencies', 'security-tests', 'uat')),
	CONSTRAINT "gate_findings_severity_check" CHECK("__new_gate_findings"."severity" in ('critical', 'high', 'moderate', 'low')),
	CONSTRAINT "gate_findings_state_check" CHECK("__new_gate_findings"."state" in ('open', 'resolved')),
	CONSTRAINT "gate_findings_outcome_check" CHECK("__new_gate_findings"."outcome" is null or "__new_gate_findings"."outcome" in ('fix-task', 'accept', 'defer', 'change-request'))
);
--> statement-breakpoint
INSERT INTO `__new_gate_findings`("id", "project_id", "release_version", "check", "fingerprint", "severity", "title", "detail", "location", "blocking", "state", "outcome", "reason", "fix_task_id", "decided_at", "first_seen_run_id", "last_seen_run_id", "created_at") SELECT "id", "project_id", "release_version", "check", "fingerprint", "severity", "title", "detail", "location", "blocking", "state", "outcome", "reason", "fix_task_id", "decided_at", "first_seen_run_id", "last_seen_run_id", "created_at" FROM `gate_findings`;--> statement-breakpoint
DROP TABLE `gate_findings`;--> statement-breakpoint
ALTER TABLE `__new_gate_findings` RENAME TO `gate_findings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `gate_findings_project_id_release_version_fingerprint_unique` ON `gate_findings` (`project_id`,`release_version`,`fingerprint`);