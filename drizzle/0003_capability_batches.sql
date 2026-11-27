CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`capability` text NOT NULL,
	`lang` text NOT NULL,
	`models` text NOT NULL,
	`test_ids` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `batch_id` text REFERENCES batches(id);--> statement-breakpoint
CREATE INDEX `sessions_batch` ON `sessions` (`batch_id`);