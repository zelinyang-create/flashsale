import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260920140041 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_allocation_campaign_fence" drop constraint if exists "flash_sale_allocation_campaign_fence_campaign_unique";`);
    this.addSql(`create table if not exists "flash_sale_allocation_campaign_fence" ("id" text not null, "campaign_id" text not null, "disposition" text check ("disposition" in ('cancelled', 'ended')) not null, "campaign_version" integer not null, "rules_version" integer not null, "version" integer not null default 1, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_allocation_campaign_fence_pkey" primary key ("id"), constraint CK_flash_sale_allocation_campaign_fence_campaign_version check (campaign_version >= 1), constraint CK_flash_sale_allocation_campaign_fence_rules_version check (rules_version >= 1), constraint CK_flash_sale_allocation_campaign_fence_version check (version >= 1));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_campaign_fence_deleted_at" ON "flash_sale_allocation_campaign_fence" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_campaign_fence_campaign_unique" ON "flash_sale_allocation_campaign_fence" ("campaign_id");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "flash_sale_allocation_campaign_fence" cascade;`);
  }

}
