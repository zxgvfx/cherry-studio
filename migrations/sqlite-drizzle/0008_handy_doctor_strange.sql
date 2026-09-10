ALTER TABLE `agent_session` ADD `branch_parent_id` text REFERENCES agent_session(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `agent_session` ADD `branch_point_message_id` text;--> statement-breakpoint
CREATE INDEX `agent_session_branch_parent_id_idx` ON `agent_session` (`branch_parent_id`);