PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`last_used_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_access_tokens`("id", "name", "token_hash", "last_used_at", "created_at") SELECT "id", "name", "token_hash", "last_used_at", "created_at" FROM `access_tokens`;--> statement-breakpoint
DROP TABLE `access_tokens`;--> statement-breakpoint
ALTER TABLE `__new_access_tokens` RENAME TO `access_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `access_tokens_token_hash_unique` ON `access_tokens` (`token_hash`);