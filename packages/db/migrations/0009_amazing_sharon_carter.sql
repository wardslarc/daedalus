CREATE TABLE `gate_findings` (
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
	CONSTRAINT "gate_findings_check_check" CHECK("gate_findings"."check" in ('secrets', 'dependencies', 'security-tests')),
	CONSTRAINT "gate_findings_severity_check" CHECK("gate_findings"."severity" in ('critical', 'high', 'moderate', 'low')),
	CONSTRAINT "gate_findings_state_check" CHECK("gate_findings"."state" in ('open', 'resolved')),
	CONSTRAINT "gate_findings_outcome_check" CHECK("gate_findings"."outcome" is null or "gate_findings"."outcome" in ('fix-task', 'accept', 'defer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gate_findings_project_id_release_version_fingerprint_unique` ON `gate_findings` (`project_id`,`release_version`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `gate_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`release_version` text NOT NULL,
	`head_sha` text NOT NULL,
	`default_sha` text,
	`status` text NOT NULL,
	`checks` text,
	`error` text,
	`started_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "gate_runs_status_check" CHECK("gate_runs"."status" in ('running', 'done', 'error'))
);
--> statement-breakpoint
CREATE TABLE `security_tests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`command` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ship_checklist_ticks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`release_version` text NOT NULL,
	`item_id` text NOT NULL,
	`ticked_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ship_checklist_ticks_project_id_release_version_item_id_unique` ON `ship_checklist_ticks` (`project_id`,`release_version`,`item_id`);--> statement-breakpoint
ALTER TABLE `shaping_state` ADD `active_milestone_verify_started_at` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `description` text;