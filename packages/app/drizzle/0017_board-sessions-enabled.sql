ALTER TABLE `boards` ADD `sessions_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Boards made before Sessions were opt-in were all made to run them, and keep doing so.
UPDATE `boards` SET `sessions_enabled` = true;
