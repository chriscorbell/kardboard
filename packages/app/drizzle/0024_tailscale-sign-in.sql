DROP TABLE `outbound_emails`;--> statement-breakpoint
DROP INDEX `users_clerk_user_id_unique`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `clerk_user_id`;--> statement-breakpoint
DELETE FROM `settings` WHERE `key` LIKE 'alert:%';