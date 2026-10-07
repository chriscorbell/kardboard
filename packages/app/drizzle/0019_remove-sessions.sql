DROP TABLE `approvals`;--> statement-breakpoint
DROP TABLE `preview_codes`;--> statement-breakpoint
DROP TABLE `previews`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
DROP TABLE `triggers`;--> statement-breakpoint
ALTER TABLE `boards` DROP COLUMN `provider`;--> statement-breakpoint
ALTER TABLE `boards` DROP COLUMN `model`;--> statement-breakpoint
ALTER TABLE `boards` DROP COLUMN `reasoning`;--> statement-breakpoint
ALTER TABLE `boards` DROP COLUMN `preview_mode`;--> statement-breakpoint
ALTER TABLE `boards` DROP COLUMN `preview_epoch`;--> statement-breakpoint
ALTER TABLE `boards` DROP COLUMN `agent_image`;--> statement-breakpoint
ALTER TABLE `boards` DROP COLUMN `max_concurrent_sessions`;--> statement-breakpoint
ALTER TABLE `boards` DROP COLUMN `prompt_append`;--> statement-breakpoint
ALTER TABLE `boards` DROP COLUMN `paused`;--> statement-breakpoint
ALTER TABLE `boards` DROP COLUMN `sessions_enabled`;--> statement-breakpoint
ALTER TABLE `cards` DROP COLUMN `pr_head_sha`;--> statement-breakpoint
ALTER TABLE `cards` DROP COLUMN `pr_base_ref`;--> statement-breakpoint
ALTER TABLE `cards` DROP COLUMN `checks`;--> statement-breakpoint
ALTER TABLE `cards` DROP COLUMN `preview_url`;--> statement-breakpoint
ALTER TABLE `cards` DROP COLUMN `pending_rerun`;--> statement-breakpoint
ALTER TABLE `comments` DROP COLUMN `session_id`;--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN ('globalMaxConcurrentSessions', 'sessionWallClockMinutes', 'providerFallback') OR `key` LIKE 'alert:runner.%' OR `key` LIKE 'alert:egress.%';
