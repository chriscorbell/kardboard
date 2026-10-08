DROP TABLE `board_members`;--> statement-breakpoint
DROP TABLE `mentions`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
DELETE FROM `outbound_emails` WHERE `status` = 'pending' AND `to_user_id` IN (SELECT `id` FROM `users` WHERE `role` != 'admin');--> statement-breakpoint
DELETE FROM `users` WHERE `role` != 'admin';--> statement-breakpoint
DROP INDEX `users_handle_unique`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `handle`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `role`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `status`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `email_preference`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `removed_at`;--> statement-breakpoint
ALTER TABLE `outbound_emails` DROP COLUMN `comment_id`;