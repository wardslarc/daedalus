CREATE TABLE `doc_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_node_id` integer NOT NULL,
	`target_node_id` integer,
	`raw_target` text NOT NULL,
	`is_embed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`source_node_id`) REFERENCES `doc_nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_node_id`) REFERENCES `doc_nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `doc_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`path` text NOT NULL,
	`heading` text,
	`slug` text,
	`content` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`kind` text NOT NULL,
	`link` text NOT NULL,
	`read` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "inbox_kind_check" CHECK("inbox"."kind" in ('review', 'approval', 'failed_check', 'quota'))
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`local_path` text NOT NULL,
	`profile` text DEFAULT 'default' NOT NULL,
	`git_host` text,
	`git_remote` text,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`gemini_allowed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_local_path_unique` ON `projects` (`local_path`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`launch_command` text NOT NULL,
	`roles` text NOT NULL,
	`allowed_profiles` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT "providers_kind_check" CHECK("providers"."kind" in ('acp', 'cli'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_name_unique` ON `providers` (`name`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`reviewer` text NOT NULL,
	`findings` text NOT NULL,
	`claude_triage` text,
	`owner_decision` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`provider_id` integer NOT NULL,
	`role` text NOT NULL,
	`start` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`end` text,
	`exit_status` integer,
	`log_path` text,
	`usage_estimate` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runs_role_check" CHECK("runs"."role" in ('implement', 'review', 'chat'))
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`code` text NOT NULL,
	`title` text NOT NULL,
	`tag` text,
	`check_command` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`linked_spec_sections` text DEFAULT '[]' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`branch` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_id_code_unique` ON `tasks` (`project_id`,`code`);--> statement-breakpoint
CREATE TABLE `usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`week` text NOT NULL,
	`amount_used` integer DEFAULT 0 NOT NULL,
	`limit` integer,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_provider_id_week_unique` ON `usage` (`provider_id`,`week`);