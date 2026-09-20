import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260919223203 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_campaign_item" drop constraint if exists "flash_sale_campaign_item_default_location_unique";`);
    this.addSql(`alter table if exists "flash_sale_campaign_item" drop constraint if exists "flash_sale_campaign_item_location_unique";`);
    this.addSql(`create table if not exists "flash_sale_campaign" ("id" text not null, "name" text not null, "description" text null, "state" text check ("state" in ('draft', 'scheduled', 'active', 'ended', 'cancelled')) not null default 'draft', "starts_at" timestamptz null, "ends_at" timestamptz null, "version" integer not null default 1, "rules_version" integer not null default 1, "campaign_epoch" integer not null default 1, "hold_ttl_seconds" integer not null default 300, "per_subject_limit" integer not null default 1, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_campaign_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_campaign_deleted_at" ON "flash_sale_campaign" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_campaign_state" ON "flash_sale_campaign" ("state") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_campaign_schedule" ON "flash_sale_campaign" ("starts_at", "ends_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "flash_sale_campaign_item" ("id" text not null, "campaign_id" text not null, "variant_id" text not null, "location_id" text null, "quota" numeric not null, "version" integer not null default 1, "metadata" jsonb null, "raw_quota" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_campaign_item_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_campaign_item_campaign_id" ON "flash_sale_campaign_item" ("campaign_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_campaign_item_deleted_at" ON "flash_sale_campaign_item" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_campaign_item_location_unique" ON "flash_sale_campaign_item" ("campaign_id", "variant_id", "location_id") WHERE deleted_at IS NULL AND location_id IS NOT NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_campaign_item_default_location_unique" ON "flash_sale_campaign_item" ("campaign_id", "variant_id") WHERE deleted_at IS NULL AND location_id IS NULL;`);

    this.addSql(`alter table if exists "flash_sale_campaign_item" add constraint "flash_sale_campaign_item_campaign_id_foreign" foreign key ("campaign_id") references "flash_sale_campaign" ("id") on update cascade on delete cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_campaign_item" drop constraint if exists "flash_sale_campaign_item_campaign_id_foreign";`);

    this.addSql(`drop table if exists "flash_sale_campaign" cascade;`);

    this.addSql(`drop table if exists "flash_sale_campaign_item" cascade;`);
  }

}
