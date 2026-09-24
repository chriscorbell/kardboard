ALTER TABLE `sessions` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `cache_creation_tokens` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `cost_usd` real;--> statement-breakpoint
ALTER TABLE `sessions` ADD `num_turns` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `duration_ms` integer;--> statement-breakpoint
CREATE INDEX `sessions_created_idx` ON `sessions` (`created_at`);