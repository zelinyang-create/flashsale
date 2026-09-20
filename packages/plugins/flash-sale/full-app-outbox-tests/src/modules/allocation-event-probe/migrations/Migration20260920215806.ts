import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260920215806 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_inbox" drop constraint if exists "flash_sale_test_probe_inbox_aggregate_version_unique";`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_inbox" drop constraint if exists "flash_sale_test_probe_inbox_event_unique";`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_effect" drop constraint if exists "flash_sale_test_probe_effect_aggregate_version_unique";`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_effect" drop constraint if exists "flash_sale_test_probe_effect_event_unique";`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_cursor" drop constraint if exists "flash_sale_test_probe_cursor_aggregate_unique";`);
    this.addSql(`create table if not exists "flash_sale_test_allocation_event_cursor" ("id" text not null, "consumer_id" text not null, "aggregate_type" text not null, "aggregate_id" text not null, "last_version" integer not null default 1, "last_event_id" text null, "last_event_hash" text null, "effect_count" integer not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_test_allocation_event_cursor_pkey" primary key ("id"), constraint CK_flash_sale_test_probe_cursor_counts check (last_version >= 1 AND effect_count >= 0));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_test_allocation_event_cursor_deleted_at" ON "flash_sale_test_allocation_event_cursor" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_cursor_aggregate_unique" ON "flash_sale_test_allocation_event_cursor" ("consumer_id", "aggregate_type", "aggregate_id");`);

    this.addSql(`create table if not exists "flash_sale_test_allocation_event_effect" ("id" text not null, "consumer_id" text not null, "event_id" text not null, "event_hash" text not null, "aggregate_type" text not null, "aggregate_id" text not null, "aggregate_version" integer not null, "effect_name" text not null, "applied_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_test_allocation_event_effect_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_test_allocation_event_effect_deleted_at" ON "flash_sale_test_allocation_event_effect" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_effect_event_unique" ON "flash_sale_test_allocation_event_effect" ("consumer_id", "event_id");`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_effect_aggregate_version_unique" ON "flash_sale_test_allocation_event_effect" ("consumer_id", "aggregate_type", "aggregate_id", "aggregate_version");`);

    this.addSql(`create table if not exists "flash_sale_test_allocation_event_inbox" ("id" text not null, "consumer_id" text not null, "event_id" text not null, "event_name" text not null, "event_hash" text not null, "aggregate_type" text not null, "aggregate_id" text not null, "aggregate_version" integer not null, "occurred_at" timestamptz not null, "payload" jsonb not null, "delivery_count" integer not null default 1, "first_received_at" timestamptz not null, "last_received_at" timestamptz not null, "processed_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_test_allocation_event_inbox_pkey" primary key ("id"), constraint CK_flash_sale_test_probe_inbox_hash check (event_hash ~ '^[0-9a-f]{64}\$'), constraint CK_flash_sale_test_probe_inbox_delivery_count check (delivery_count >= 1), constraint CK_flash_sale_test_probe_inbox_payload check (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_test_allocation_event_inbox_deleted_at" ON "flash_sale_test_allocation_event_inbox" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_inbox_event_unique" ON "flash_sale_test_allocation_event_inbox" ("consumer_id", "event_id");`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_inbox_aggregate_version_unique" ON "flash_sale_test_allocation_event_inbox" ("consumer_id", "aggregate_type", "aggregate_id", "aggregate_version");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "flash_sale_test_allocation_event_cursor" cascade;`);

    this.addSql(`drop table if exists "flash_sale_test_allocation_event_effect" cascade;`);

    this.addSql(`drop table if exists "flash_sale_test_allocation_event_inbox" cascade;`);
  }

}
