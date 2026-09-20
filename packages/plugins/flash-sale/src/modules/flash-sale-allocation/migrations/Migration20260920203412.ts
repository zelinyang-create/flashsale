import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260920203412 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_allocation_outbox_event" drop constraint if exists CK_flash_sale_allocation_outbox_counts;`);
    this.addSql(`alter table if exists "flash_sale_allocation_outbox_event" drop constraint if exists CK_flash_sale_allocation_outbox_status_fields;`);

    this.addSql(`alter table if exists "flash_sale_allocation_outbox_event" add constraint CK_flash_sale_allocation_outbox_bounded_identifiers check(char_length(event_name) BETWEEN 1 AND 160 AND char_length(aggregate_type) BETWEEN 1 AND 64 AND char_length(aggregate_id) BETWEEN 1 AND 255 AND (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 255) AND (published_by IS NULL OR char_length(published_by) BETWEEN 1 AND 255) AND (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,127}\$'));`);
    this.addSql(`alter table if exists "flash_sale_allocation_outbox_event" add constraint CK_flash_sale_allocation_outbox_counts check(attempt_count >= 0 AND lease_epoch >= 0 AND redrive_count >= 0 AND (max_attempts IS NULL OR (max_attempts >= 1 AND max_attempts <= 100)) AND (published_lease_epoch IS NULL OR published_lease_epoch >= 1));`);
    this.addSql(`alter table if exists "flash_sale_allocation_outbox_event" add constraint CK_flash_sale_allocation_outbox_status_fields check((status = 'pending' AND lease_owner IS NULL AND lease_until IS NULL AND published_at IS NULL AND published_by IS NULL AND published_lease_epoch IS NULL AND dead_lettered_at IS NULL) OR (status = 'publishing' AND attempt_count >= 1 AND max_attempts IS NOT NULL AND lease_owner IS NOT NULL AND lease_until IS NOT NULL AND published_at IS NULL AND published_by IS NULL AND published_lease_epoch IS NULL AND dead_lettered_at IS NULL) OR (status = 'published' AND attempt_count >= 1 AND max_attempts IS NOT NULL AND lease_owner IS NULL AND lease_until IS NULL AND published_at IS NOT NULL AND published_by IS NOT NULL AND published_lease_epoch IS NOT NULL AND dead_lettered_at IS NULL) OR (status = 'dead_letter' AND attempt_count >= 1 AND max_attempts IS NOT NULL AND lease_owner IS NULL AND lease_until IS NULL AND published_at IS NULL AND published_by IS NULL AND published_lease_epoch IS NULL AND dead_lettered_at IS NOT NULL));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_allocation_outbox_event" drop constraint if exists CK_flash_sale_allocation_outbox_bounded_identifiers;`);
    this.addSql(`alter table if exists "flash_sale_allocation_outbox_event" drop constraint if exists CK_flash_sale_allocation_outbox_counts;`);
    this.addSql(`alter table if exists "flash_sale_allocation_outbox_event" drop constraint if exists CK_flash_sale_allocation_outbox_status_fields;`);

    this.addSql(`alter table if exists "flash_sale_allocation_outbox_event" add constraint CK_flash_sale_allocation_outbox_counts check(attempt_count >= 0 AND lease_epoch >= 0 AND redrive_count >= 0 AND (max_attempts IS NULL OR (max_attempts >= 1 AND max_attempts <= 100)));`);
    this.addSql(`alter table if exists "flash_sale_allocation_outbox_event" add constraint CK_flash_sale_allocation_outbox_status_fields check((status = 'pending' AND lease_owner IS NULL AND lease_until IS NULL AND published_at IS NULL AND published_by IS NULL AND published_lease_epoch IS NULL AND dead_lettered_at IS NULL) OR (status = 'publishing' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL AND published_at IS NULL AND published_by IS NULL AND published_lease_epoch IS NULL AND dead_lettered_at IS NULL) OR (status = 'published' AND lease_owner IS NULL AND lease_until IS NULL AND published_at IS NOT NULL AND published_by IS NOT NULL AND published_lease_epoch IS NOT NULL AND dead_lettered_at IS NULL) OR (status = 'dead_letter' AND lease_owner IS NULL AND lease_until IS NULL AND published_at IS NULL AND published_by IS NULL AND published_lease_epoch IS NULL AND dead_lettered_at IS NOT NULL));`);
  }

}
