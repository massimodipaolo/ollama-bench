CREATE TABLE `case_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`case_id` text NOT NULL,
	`output` text,
	`reasoning` text,
	`data` text,
	`latency_ms` real,
	`ttft_ms` real,
	`tokens_in` integer,
	`tokens_out` integer,
	`reasoning_tokens` integer,
	`tok_per_sec` real,
	`auto_score` real,
	`checks` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `case_results_run` ON `case_results` (`run_id`);--> statement-breakpoint
CREATE TABLE `judgments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`case_result_id` integer NOT NULL,
	`judge` text NOT NULL,
	`judge_model` text NOT NULL,
	`rubric_version` text NOT NULL,
	`cache_key` text NOT NULL,
	`score` real,
	`criteria` text,
	`rationale` text,
	`latency_ms` real,
	`cached` integer DEFAULT false NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`case_result_id`) REFERENCES `case_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `judgments_case` ON `judgments` (`case_result_id`);--> statement-breakpoint
CREATE INDEX `judgments_cache` ON `judgments` (`cache_key`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`digest` text DEFAULT '' NOT NULL,
	`family` text,
	`parameter_size` text,
	`quantization` text,
	`context_length` integer,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`first_seen` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `models_provider_name_digest` ON `models` (`provider`,`name`,`digest`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`model_id` integer NOT NULL,
	`role` text DEFAULT 'candidate' NOT NULL,
	`blind_label` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`load_ms` real,
	`auto_score` real,
	`judge_scores` text,
	`judge_avg` real,
	`avg_latency_ms` real,
	`avg_ttft_ms` real,
	`avg_tok_per_sec` real,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_session` ON `runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `runs_model` ON `runs` (`model_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`test_id` text NOT NULL,
	`suite_version` text NOT NULL,
	`lang` text NOT NULL,
	`config` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `sessions_test` ON `sessions` (`test_id`,`created_at`);