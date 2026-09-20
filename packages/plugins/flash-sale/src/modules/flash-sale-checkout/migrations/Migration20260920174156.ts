import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260920174156 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_checkout_execution" add column if not exists "commerce_result_hash" text null, add column if not exists "terminal_command_hash" text null;`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" add constraint CK_flash_sale_checkout_result_hash check(commerce_result_hash IS NULL OR commerce_result_hash ~ '^[0-9a-f]{64}\$');`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" add constraint CK_flash_sale_checkout_terminal_hash check(terminal_command_hash IS NULL OR terminal_command_hash ~ '^[0-9a-f]{64}\$');`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" add constraint CK_flash_sale_checkout_success_result check(state NOT IN ('commerce_succeeded', 'completed') OR (order_id IS NOT NULL AND last_error_code IS NULL));`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" add constraint CK_flash_sale_checkout_failed_result check(state NOT IN ('commerce_definitive_failed', 'canceled') OR (order_id IS NULL AND last_error_code IS NOT NULL));`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" add constraint CK_flash_sale_checkout_unknown_result check(state <> 'commerce_unknown' OR (order_id IS NULL AND last_error_code IS NOT NULL AND next_reconcile_at IS NOT NULL));`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" add constraint CK_flash_sale_checkout_order_state check(order_id IS NULL OR state IN ('commerce_succeeded', 'completed'));`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" add constraint CK_flash_sale_checkout_reconcile_state check((state = 'commerce_unknown') = (next_reconcile_at IS NOT NULL));`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" add constraint CK_flash_sale_checkout_resolved_state check((state IN ('commerce_succeeded', 'commerce_definitive_failed', 'completed', 'canceled')) = (commerce_resolved_at IS NOT NULL));`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" add constraint CK_flash_sale_checkout_terminal_state check((state IN ('completed', 'canceled', 'manual_review')) = (terminal_at IS NOT NULL));`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" add constraint CK_flash_sale_checkout_result_hash_state check((state IN ('commerce_succeeded', 'commerce_definitive_failed', 'commerce_unknown', 'completed', 'canceled')) = (commerce_result_hash IS NOT NULL));`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" add constraint CK_flash_sale_checkout_terminal_hash_state check((state IN ('completed', 'canceled')) = (terminal_command_hash IS NOT NULL));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_checkout_execution" drop constraint if exists CK_flash_sale_checkout_result_hash;`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" drop constraint if exists CK_flash_sale_checkout_terminal_hash;`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" drop constraint if exists CK_flash_sale_checkout_success_result;`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" drop constraint if exists CK_flash_sale_checkout_failed_result;`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" drop constraint if exists CK_flash_sale_checkout_unknown_result;`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" drop constraint if exists CK_flash_sale_checkout_order_state;`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" drop constraint if exists CK_flash_sale_checkout_reconcile_state;`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" drop constraint if exists CK_flash_sale_checkout_resolved_state;`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" drop constraint if exists CK_flash_sale_checkout_terminal_state;`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" drop constraint if exists CK_flash_sale_checkout_result_hash_state;`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" drop constraint if exists CK_flash_sale_checkout_terminal_hash_state;`);
    this.addSql(`alter table if exists "flash_sale_checkout_execution" drop column if exists "commerce_result_hash", drop column if exists "terminal_command_hash";`);
  }

}
