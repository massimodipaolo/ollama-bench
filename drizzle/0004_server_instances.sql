CREATE TABLE `server_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`pid` integer NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`heartbeat_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `instance_id` text;