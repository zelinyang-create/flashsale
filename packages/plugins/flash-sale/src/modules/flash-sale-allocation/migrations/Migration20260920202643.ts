import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260920202643 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_allocation_outbox_event" drop constraint if exists "flash_sale_allocation_outbox_aggregate_version_unique";`);
    this.addSql(`create table if not exists "flash_sale_allocation_outbox_control" ("id" text not null, "required_after" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_allocation_outbox_control_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_outbox_control_deleted_at" ON "flash_sale_allocation_outbox_control" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "flash_sale_allocation_outbox_event" ("id" text not null, "event_name" text not null, "schema_version" integer not null, "aggregate_type" text not null, "aggregate_id" text not null, "aggregate_version" integer not null, "event_hash" text not null, "payload" jsonb not null, "status" text check ("status" in ('pending', 'publishing', 'published', 'dead_letter')) not null default 'pending', "available_at" timestamptz not null, "occurred_at" timestamptz not null, "published_at" timestamptz null, "attempt_count" integer not null default 0, "max_attempts" integer null, "lease_owner" text null, "lease_until" timestamptz null, "lease_epoch" integer not null default 0, "published_by" text null, "published_lease_epoch" integer null, "last_error_code" text null, "dead_lettered_at" timestamptz null, "redrive_count" integer not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_allocation_outbox_event_pkey" primary key ("id"), constraint CK_flash_sale_allocation_outbox_schema_version check (schema_version >= 1), constraint CK_flash_sale_allocation_outbox_aggregate_version check (aggregate_version >= 1), constraint CK_flash_sale_allocation_outbox_hash check (event_hash ~ '^[0-9a-f]{64}\$'), constraint CK_flash_sale_allocation_outbox_payload check (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536), constraint CK_flash_sale_allocation_outbox_counts check (attempt_count >= 0 AND lease_epoch >= 0 AND redrive_count >= 0 AND (max_attempts IS NULL OR (max_attempts >= 1 AND max_attempts <= 100))), constraint CK_flash_sale_allocation_outbox_status_fields check ((status = 'pending' AND lease_owner IS NULL AND lease_until IS NULL AND published_at IS NULL AND published_by IS NULL AND published_lease_epoch IS NULL AND dead_lettered_at IS NULL) OR (status = 'publishing' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL AND published_at IS NULL AND published_by IS NULL AND published_lease_epoch IS NULL AND dead_lettered_at IS NULL) OR (status = 'published' AND lease_owner IS NULL AND lease_until IS NULL AND published_at IS NOT NULL AND published_by IS NOT NULL AND published_lease_epoch IS NOT NULL AND dead_lettered_at IS NULL) OR (status = 'dead_letter' AND lease_owner IS NULL AND lease_until IS NULL AND published_at IS NULL AND published_by IS NULL AND published_lease_epoch IS NULL AND dead_lettered_at IS NOT NULL)));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_outbox_event_deleted_at" ON "flash_sale_allocation_outbox_event" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_outbox_aggregate_version_unique" ON "flash_sale_allocation_outbox_event" ("aggregate_type", "aggregate_id", "aggregate_version");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_outbox_due" ON "flash_sale_allocation_outbox_event" ("status", "available_at", "occurred_at", "id") WHERE deleted_at IS NULL AND status = 'pending';`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_outbox_recovery" ON "flash_sale_allocation_outbox_event" ("status", "lease_until", "id") WHERE deleted_at IS NULL AND status = 'publishing';`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_outbox_dead" ON "flash_sale_allocation_outbox_event" ("dead_lettered_at", "id") WHERE deleted_at IS NULL AND status = 'dead_letter';`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_outbox_head" ON "flash_sale_allocation_outbox_event" ("aggregate_type", "aggregate_id", "aggregate_version") WHERE deleted_at IS NULL AND status <> 'published';`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "flash_sale_allocation_outbox_control" cascade;`);

    this.addSql(`drop table if exists "flash_sale_allocation_outbox_event" cascade;`);
  }

}
