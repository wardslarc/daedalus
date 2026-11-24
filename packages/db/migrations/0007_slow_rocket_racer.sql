ALTER TABLE `reviews` ADD `status` text DEFAULT 'running' NOT NULL;--> statement-breakpoint
ALTER TABLE `reviews` ADD `head_sha` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `started_at` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `finished_at` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `error` text;