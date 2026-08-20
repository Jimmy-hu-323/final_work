CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bills` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`due_at` text NOT NULL,
	`version` integer NOT NULL,
	`breakdown` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`confirmation_no` text NOT NULL,
	`hotel_id` text NOT NULL,
	`user_id` text NOT NULL,
	`check_in` text NOT NULL,
	`check_out` text NOT NULL,
	`room_name` text NOT NULL,
	`guests` integer NOT NULL,
	`rooms` integer NOT NULL,
	`status` text NOT NULL,
	`quote_version` integer NOT NULL,
	`total_amount` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_confirmation_no_unique` ON `bookings` (`confirmation_no`);--> statement-breakpoint
CREATE TABLE `daily_inventory` (
	`hotel_id` text NOT NULL,
	`stay_date` text NOT NULL,
	`room_name` text NOT NULL,
	`price` integer NOT NULL,
	`available_rooms` integer NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	PRIMARY KEY(`hotel_id`, `stay_date`)
);
--> statement-breakpoint
CREATE TABLE `hotels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`area` text NOT NULL,
	`address` text NOT NULL,
	`stars` integer NOT NULL,
	`rating` integer NOT NULL,
	`description` text NOT NULL,
	`accent` text NOT NULL,
	`distance` text NOT NULL,
	`amenities` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payment_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`agent_name` text NOT NULL,
	`bill_ids` text NOT NULL,
	`max_amount` integer NOT NULL,
	`currency` text NOT NULL,
	`quote_versions` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
