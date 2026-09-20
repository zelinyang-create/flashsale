import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260919231655 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_subject_allocation" drop constraint if exists "flash_sale_subject_campaign_subject_unique";`);
    this.addSql(`alter table if exists "flash_sale_allocation_hold" drop constraint if exists "flash_sale_hold_attempt_item_unique";`);
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop constraint if exists "flash_sale_attempt_live_cart_unique";`);
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop constraint if exists "flash_sale_attempt_idempotency_unique";`);
    this.addSql(`alter table if exists "flash_sale_capacity" drop constraint if exists "flash_sale_capacity_policy_item_shard_unique";`);
    this.addSql(`alter table if exists "flash_sale_allocation_policy" drop constraint if exists "flash_sale_allocation_policy_live_campaign_unique";`);
    this.addSql(`alter table if exists "flash_sale_allocation_policy" drop constraint if exists "flash_sale_allocation_policy_campaign_rules_unique";`);
    this.addSql(`create table if not exists "flash_sale_allocation_policy" ("id" text not null, "campaign_id" text not null, "rules_version" integer not null, "configuration_hash" text not null, "state" text check ("state" in ('prepared', 'open', 'closed')) not null default 'prepared', "starts_at" timestamptz not null, "ends_at" timestamptz not null, "hold_ttl_seconds" integer not null, "per_subject_limit" integer not null, "version" integer not null default 1, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_allocation_policy_pkey" primary key ("id"), constraint CK_flash_sale_allocation_policy_rules_version check (rules_version >= 1), constraint CK_flash_sale_allocation_policy_version check (version >= 1), constraint CK_flash_sale_allocation_policy_hold_ttl check (hold_ttl_seconds BETWEEN 1 AND 86400), constraint CK_flash_sale_allocation_policy_subject_limit check (per_subject_limit >= 1), constraint CK_flash_sale_allocation_policy_window check (ends_at > starts_at), constraint CK_flash_sale_allocation_policy_configuration_hash check (char_length(configuration_hash) = 64));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_policy_deleted_at" ON "flash_sale_allocation_policy" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_policy_campaign_rules_unique" ON "flash_sale_allocation_policy" ("campaign_id", "rules_version");`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_policy_live_campaign_unique" ON "flash_sale_allocation_policy" ("campaign_id") WHERE deleted_at IS NULL AND state IN ('prepared', 'open');`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_policy_live_schedule" ON "flash_sale_allocation_policy" ("state", "starts_at", "ends_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "flash_sale_capacity" ("id" text not null, "allocation_policy_id" text not null, "campaign_item_id" text not null, "shard_no" integer not null default 0, "state" text check ("state" in ('prepared', 'open', 'closed')) not null default 'prepared', "granted_quantity" numeric not null, "held_quantity" numeric not null default 0, "consumed_quantity" numeric not null default 0, "rules_version" integer not null, "version" integer not null default 1, "raw_granted_quantity" jsonb not null, "raw_held_quantity" jsonb not null default '{"value":"0","precision":20}', "raw_consumed_quantity" jsonb not null default '{"value":"0","precision":20}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_capacity_pkey" primary key ("id"), constraint CK_flash_sale_capacity_single_shard check (shard_no = 0), constraint CK_flash_sale_capacity_granted_positive check (granted_quantity > 0), constraint CK_flash_sale_capacity_held_nonnegative check (held_quantity >= 0), constraint CK_flash_sale_capacity_consumed_nonnegative check (consumed_quantity >= 0), constraint CK_flash_sale_capacity_balance check (held_quantity + consumed_quantity <= granted_quantity), constraint CK_flash_sale_capacity_rules_version check (rules_version >= 1), constraint CK_flash_sale_capacity_version check (version >= 1));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_allocation_policy_id" ON "flash_sale_capacity" ("allocation_policy_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_deleted_at" ON "flash_sale_capacity" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_policy_item_shard_unique" ON "flash_sale_capacity" ("allocation_policy_id", "campaign_item_id", "shard_no");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_policy_state" ON "flash_sale_capacity" ("allocation_policy_id", "state");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_live_campaign_item" ON "flash_sale_capacity" ("campaign_item_id") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "flash_sale_purchase_attempt" ("id" text not null, "allocation_policy_id" text not null, "campaign_id" text not null, "subject_id" text not null, "cart_id" text null, "idempotency_key_hash" text not null, "request_hash" text not null, "state" text check ("state" in ('pending', 'quota_held', 'quota_rejected', 'quota_consumed', 'quota_released')) not null default 'pending', "rules_version" integer not null, "expires_at" timestamptz not null, "version" integer not null default 1, "last_error_code" text null, "terminal_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_purchase_attempt_pkey" primary key ("id"), constraint CK_flash_sale_attempt_version check (version >= 1), constraint CK_flash_sale_attempt_rules_version check (rules_version >= 1), constraint CK_flash_sale_attempt_idempotency_hash check (char_length(idempotency_key_hash) = 64), constraint CK_flash_sale_attempt_request_hash check (char_length(request_hash) = 64));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_purchase_attempt_allocation_policy_id" ON "flash_sale_purchase_attempt" ("allocation_policy_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_purchase_attempt_deleted_at" ON "flash_sale_purchase_attempt" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_attempt_idempotency_unique" ON "flash_sale_purchase_attempt" ("campaign_id", "subject_id", "idempotency_key_hash");`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_attempt_live_cart_unique" ON "flash_sale_purchase_attempt" ("campaign_id", "cart_id") WHERE deleted_at IS NULL AND cart_id IS NOT NULL AND state IN ('pending', 'quota_held');`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_attempt_held_expiry" ON "flash_sale_purchase_attempt" ("state", "expires_at") WHERE deleted_at IS NULL AND state = 'quota_held';`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_attempt_live_subject_state" ON "flash_sale_purchase_attempt" ("campaign_id", "subject_id", "state") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "flash_sale_allocation_hold" ("id" text not null, "attempt_id" text not null, "capacity_id" text not null, "campaign_item_id" text not null, "quantity" numeric not null, "state" text check ("state" in ('held', 'consumed', 'released')) not null default 'held', "expires_at" timestamptz not null, "version" integer not null default 1, "resolved_at" timestamptz null, "raw_quantity" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_allocation_hold_pkey" primary key ("id"), constraint CK_flash_sale_hold_quantity check (quantity > 0), constraint CK_flash_sale_hold_version check (version >= 1));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_hold_attempt_id" ON "flash_sale_allocation_hold" ("attempt_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_hold_capacity_id" ON "flash_sale_allocation_hold" ("capacity_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_allocation_hold_deleted_at" ON "flash_sale_allocation_hold" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_hold_attempt_item_unique" ON "flash_sale_allocation_hold" ("attempt_id", "campaign_item_id");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_hold_capacity_state" ON "flash_sale_allocation_hold" ("capacity_id", "state");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_hold_held_expiry" ON "flash_sale_allocation_hold" ("state", "expires_at") WHERE deleted_at IS NULL AND state = 'held';`);

    this.addSql(`create table if not exists "flash_sale_subject_allocation" ("id" text not null, "campaign_id" text not null, "subject_id" text not null, "limit_quantity" numeric not null, "held_quantity" numeric not null default 0, "consumed_quantity" numeric not null default 0, "rules_version" integer not null, "version" integer not null default 1, "raw_limit_quantity" jsonb not null, "raw_held_quantity" jsonb not null default '{"value":"0","precision":20}', "raw_consumed_quantity" jsonb not null default '{"value":"0","precision":20}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_subject_allocation_pkey" primary key ("id"), constraint CK_flash_sale_subject_limit check (limit_quantity > 0), constraint CK_flash_sale_subject_held_nonnegative check (held_quantity >= 0), constraint CK_flash_sale_subject_consumed_nonnegative check (consumed_quantity >= 0), constraint CK_flash_sale_subject_balance check (held_quantity + consumed_quantity <= limit_quantity), constraint CK_flash_sale_subject_rules_version check (rules_version >= 1), constraint CK_flash_sale_subject_version check (version >= 1));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_subject_allocation_deleted_at" ON "flash_sale_subject_allocation" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_subject_campaign_subject_unique" ON "flash_sale_subject_allocation" ("campaign_id", "subject_id");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_subject_live_campaign" ON "flash_sale_subject_allocation" ("campaign_id") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "flash_sale_capacity" add constraint "flash_sale_capacity_allocation_policy_id_foreign" foreign key ("allocation_policy_id") references "flash_sale_allocation_policy" ("id") on update cascade;`);

    this.addSql(`alter table if exists "flash_sale_purchase_attempt" add constraint "flash_sale_purchase_attempt_allocation_policy_id_foreign" foreign key ("allocation_policy_id") references "flash_sale_allocation_policy" ("id") on update cascade;`);

    this.addSql(`alter table if exists "flash_sale_allocation_hold" add constraint "flash_sale_allocation_hold_attempt_id_foreign" foreign key ("attempt_id") references "flash_sale_purchase_attempt" ("id") on update cascade;`);
    this.addSql(`alter table if exists "flash_sale_allocation_hold" add constraint "flash_sale_allocation_hold_capacity_id_foreign" foreign key ("capacity_id") references "flash_sale_capacity" ("id") on update cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_capacity" drop constraint if exists "flash_sale_capacity_allocation_policy_id_foreign";`);

    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop constraint if exists "flash_sale_purchase_attempt_allocation_policy_id_foreign";`);

    this.addSql(`alter table if exists "flash_sale_allocation_hold" drop constraint if exists "flash_sale_allocation_hold_capacity_id_foreign";`);

    this.addSql(`alter table if exists "flash_sale_allocation_hold" drop constraint if exists "flash_sale_allocation_hold_attempt_id_foreign";`);

    this.addSql(`drop table if exists "flash_sale_allocation_policy" cascade;`);

    this.addSql(`drop table if exists "flash_sale_capacity" cascade;`);

    this.addSql(`drop table if exists "flash_sale_purchase_attempt" cascade;`);

    this.addSql(`drop table if exists "flash_sale_allocation_hold" cascade;`);

    this.addSql(`drop table if exists "flash_sale_subject_allocation" cascade;`);
  }

}
