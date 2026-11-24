CREATE TABLE `review_acks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`gate` text NOT NULL,
	`acked_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`note` text NOT NULL,
	`head_sha` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_acks_task_id_gate_unique` ON `review_acks` (`task_id`,`gate`);--> statement-breakpoint
ALTER TABLE `runs` ADD `check_exit_code` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `check_output` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `review_notes` text;