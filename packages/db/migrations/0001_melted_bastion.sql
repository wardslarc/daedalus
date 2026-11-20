PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`local_path` text NOT NULL,
	`profile` text NOT NULL,
	`git_host` text,
	`git_remote` text,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`gemini_allowed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT "projects_profile_check" CHECK("__new_projects"."profile" in ('work', 'client', 'personal'))
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "name", "local_path", "profile", "git_host", "git_remote", "default_branch", "gemini_allowed", "created_at") SELECT "id", "name", "local_path", "profile", "git_host", "git_remote", "default_branch", "gemini_allowed", "created_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_local_path_unique` ON `projects` (`local_path`);