import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260920164953 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "flash_sale_checkout_execution_item" drop constraint if exists "flash_sale_checkout_item_variant_unique";`
    )
    this.addSql(
      `alter table if exists "flash_sale_checkout_execution_item" drop constraint if exists "flash_sale_checkout_item_campaign_unique";`
    )
    this.addSql(
      `alter table if exists "flash_sale_checkout_execution" drop constraint if exists "flash_sale_checkout_live_order_unique";`
    )
    this.addSql(
      `alter table if exists "flash_sale_checkout_execution" drop constraint if exists "flash_sale_checkout_execution_commerce_transaction_id_unique";`
    )
    this.addSql(
      `alter table if exists "flash_sale_checkout_execution" drop constraint if exists "flash_sale_checkout_execution_command_id_unique";`
    )
    this.addSql(
      `alter table if exists "flash_sale_checkout_execution" drop constraint if exists "flash_sale_checkout_execution_cart_id_unique";`
    )
    this.addSql(
      `alter table if exists "flash_sale_checkout_execution" drop constraint if exists "flash_sale_checkout_execution_attempt_id_unique";`
    )
    this.addSql(
      `create table if not exists "flash_sale_checkout_execution" ("id" text not null, "attempt_id" text not null, "campaign_id" text not null, "subject_id" text not null, "cart_id" text not null, "command_id" text not null, "request_hash" text not null, "commerce_transaction_id" text not null, "rules_version" integer not null, "state" text check ("state" in ('prepared', 'commerce_pending', 'commerce_succeeded', 'commerce_definitive_failed', 'commerce_unknown', 'completed', 'canceled', 'manual_review')) not null default 'prepared', "order_id" text null, "version" integer not null default 1, "attempt_count" integer not null default 0, "lease_owner" text null, "lease_until" timestamptz null, "lease_epoch" integer not null default 0, "completion_authorized_epoch" integer null, "completion_authorized_at" timestamptz null, "next_reconcile_at" timestamptz null, "last_error_code" text null, "commerce_started_at" timestamptz null, "commerce_resolved_at" timestamptz null, "terminal_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_checkout_execution_pkey" primary key ("id"), constraint CK_flash_sale_checkout_request_hash check (request_hash ~ '^[0-9a-f]{64}\$'), constraint CK_flash_sale_checkout_rules_version check (rules_version >= 1), constraint CK_flash_sale_checkout_version check (version >= 1), constraint CK_flash_sale_checkout_attempt_count check (attempt_count >= 0), constraint CK_flash_sale_checkout_lease_epoch check (lease_epoch >= 0), constraint CK_flash_sale_checkout_authorized_epoch check (completion_authorized_epoch IS NULL OR completion_authorized_epoch >= 1), constraint CK_flash_sale_checkout_authorized_pair check ((completion_authorized_epoch IS NULL) = (completion_authorized_at IS NULL)), constraint CK_flash_sale_checkout_authorized_fence check (completion_authorized_epoch IS NULL OR (state = 'commerce_pending' AND completion_authorized_epoch = lease_epoch)), constraint CK_flash_sale_checkout_lease_pair check ((lease_owner IS NULL AND lease_until IS NULL) OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)), constraint CK_flash_sale_checkout_lease_state check ((state = 'commerce_pending') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)));`
    )
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_checkout_execution_attempt_id_unique" ON "flash_sale_checkout_execution" ("attempt_id") WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_checkout_execution_cart_id_unique" ON "flash_sale_checkout_execution" ("cart_id") WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_checkout_execution_command_id_unique" ON "flash_sale_checkout_execution" ("command_id") WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_checkout_execution_commerce_transaction_id_unique" ON "flash_sale_checkout_execution" ("commerce_transaction_id") WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_flash_sale_checkout_execution_deleted_at" ON "flash_sale_checkout_execution" ("deleted_at") WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_checkout_live_order_unique" ON "flash_sale_checkout_execution" ("order_id") WHERE deleted_at IS NULL AND order_id IS NOT NULL;`
    )
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_flash_sale_checkout_campaign_state" ON "flash_sale_checkout_execution" ("campaign_id", "state") WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_flash_sale_checkout_reconcile_due" ON "flash_sale_checkout_execution" ("state", "next_reconcile_at") WHERE deleted_at IS NULL AND next_reconcile_at IS NOT NULL;`
    )
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_flash_sale_checkout_active_lease" ON "flash_sale_checkout_execution" ("state", "lease_until") WHERE deleted_at IS NULL AND state = 'commerce_pending';`
    )

    this.addSql(
      `create table if not exists "flash_sale_checkout_execution_item" ("id" text not null, "execution_id" text not null, "campaign_item_id" text not null, "variant_id" text not null, "quantity" numeric not null, "raw_quantity" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_checkout_execution_item_pkey" primary key ("id"), constraint CK_flash_sale_checkout_item_quantity check (quantity > 0));`
    )
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_flash_sale_checkout_execution_item_execution_id" ON "flash_sale_checkout_execution_item" ("execution_id") WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_flash_sale_checkout_execution_item_deleted_at" ON "flash_sale_checkout_execution_item" ("deleted_at") WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_checkout_item_campaign_unique" ON "flash_sale_checkout_execution_item" ("execution_id", "campaign_item_id");`
    )
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_checkout_item_variant_unique" ON "flash_sale_checkout_execution_item" ("execution_id", "variant_id");`
    )

    this.addSql(
      `alter table if exists "flash_sale_checkout_execution_item" add constraint "flash_sale_checkout_execution_item_execution_id_foreign" foreign key ("execution_id") references "flash_sale_checkout_execution" ("id") on update cascade;`
    )
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "flash_sale_checkout_execution_item" drop constraint if exists "flash_sale_checkout_execution_item_execution_id_foreign";`
    )

    this.addSql(`drop table if exists "flash_sale_checkout_execution" cascade;`)

    this.addSql(
      `drop table if exists "flash_sale_checkout_execution_item" cascade;`
    )
  }
}
