import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260921042052 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_inbox" drop constraint if exists "flash_sale_test_probe_inbox_source_aggregate_version_unique";`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_inbox" drop constraint if exists "flash_sale_test_probe_inbox_source_event_unique";`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_effect" drop constraint if exists "flash_sale_test_probe_effect_source_aggregate_version_unique";`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_effect" drop constraint if exists "flash_sale_test_probe_effect_source_event_unique";`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_cursor" drop constraint if exists "flash_sale_test_probe_cursor_source_aggregate_unique";`);
    this.addSql(`drop index if exists "IDX_flash_sale_test_probe_cursor_aggregate_unique";`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_cursor" drop constraint if exists CK_flash_sale_test_probe_cursor_counts;`);

    this.addSql(`alter table if exists "flash_sale_test_allocation_event_cursor" add column if not exists "source_module" text not null default 'allocation';`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_cursor" alter column "last_version" type integer using ("last_version"::integer);`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_cursor" alter column "last_version" set default 0;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_cursor_source_aggregate_unique" ON "flash_sale_test_allocation_event_cursor" ("consumer_id", "source_module", "aggregate_type", "aggregate_id");`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_cursor" add constraint CK_flash_sale_test_probe_cursor_counts check(last_version >= 0 AND effect_count >= 0);`);

    this.addSql(`drop index if exists "IDX_flash_sale_test_probe_effect_event_unique";`);
    this.addSql(`drop index if exists "IDX_flash_sale_test_probe_effect_aggregate_version_unique";`);

    this.addSql(`alter table if exists "flash_sale_test_allocation_event_effect" add column if not exists "source_module" text not null default 'allocation';`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_effect_source_event_unique" ON "flash_sale_test_allocation_event_effect" ("consumer_id", "source_module", "event_id");`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_effect_source_aggregate_version_unique" ON "flash_sale_test_allocation_event_effect" ("consumer_id", "source_module", "aggregate_type", "aggregate_id", "aggregate_version");`);

    this.addSql(`drop index if exists "IDX_flash_sale_test_probe_inbox_event_unique";`);
    this.addSql(`drop index if exists "IDX_flash_sale_test_probe_inbox_aggregate_version_unique";`);

    this.addSql(`alter table if exists "flash_sale_test_allocation_event_inbox" add column if not exists "source_module" text not null default 'allocation';`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_inbox_source_event_unique" ON "flash_sale_test_allocation_event_inbox" ("consumer_id", "source_module", "event_id");`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_inbox_source_aggregate_version_unique" ON "flash_sale_test_allocation_event_inbox" ("consumer_id", "source_module", "aggregate_type", "aggregate_id", "aggregate_version");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_flash_sale_test_probe_cursor_source_aggregate_unique";`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_cursor" drop constraint if exists CK_flash_sale_test_probe_cursor_counts;`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_cursor" drop column if exists "source_module";`);

    this.addSql(`alter table if exists "flash_sale_test_allocation_event_cursor" alter column "last_version" type integer using ("last_version"::integer);`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_cursor" alter column "last_version" set default 1;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_cursor_aggregate_unique" ON "flash_sale_test_allocation_event_cursor" ("consumer_id", "aggregate_type", "aggregate_id");`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_cursor" add constraint CK_flash_sale_test_probe_cursor_counts check(last_version >= 1 AND effect_count >= 0);`);

    this.addSql(`drop index if exists "IDX_flash_sale_test_probe_effect_source_event_unique";`);
    this.addSql(`drop index if exists "IDX_flash_sale_test_probe_effect_source_aggregate_version_unique";`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_effect" drop column if exists "source_module";`);

    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_effect_event_unique" ON "flash_sale_test_allocation_event_effect" ("consumer_id", "event_id");`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_effect_aggregate_version_unique" ON "flash_sale_test_allocation_event_effect" ("consumer_id", "aggregate_type", "aggregate_id", "aggregate_version");`);

    this.addSql(`drop index if exists "IDX_flash_sale_test_probe_inbox_source_event_unique";`);
    this.addSql(`drop index if exists "IDX_flash_sale_test_probe_inbox_source_aggregate_version_unique";`);
    this.addSql(`alter table if exists "flash_sale_test_allocation_event_inbox" drop column if exists "source_module";`);

    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_inbox_event_unique" ON "flash_sale_test_allocation_event_inbox" ("consumer_id", "event_id");`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_test_probe_inbox_aggregate_version_unique" ON "flash_sale_test_allocation_event_inbox" ("consumer_id", "aggregate_type", "aggregate_id", "aggregate_version");`);
  }

}
