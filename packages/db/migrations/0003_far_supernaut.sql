CREATE TABLE `shaping_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`intake_completed_at` text,
	`spec_approved_at` text,
	`mock_provider_id` text,
	`mock_artifact_url` text,
	`mock_approved_by` text,
	`mock_approved_at` text,
	`plan_approved_at` text,
	`active_milestone_version` text,
	`active_milestone_code` text,
	`active_milestone_branch` text,
	`active_milestone_started_at` text,
	`active_milestone_frozen` integer,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shaping_state_project_id_unique` ON `shaping_state` (`project_id`);