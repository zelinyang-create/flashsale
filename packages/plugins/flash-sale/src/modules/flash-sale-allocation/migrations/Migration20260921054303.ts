import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260921054303 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_capacity_movement" drop constraint if exists "flash_sale_movement_attempt_item_transition_unique";`);
    this.addSql(`alter table if exists "flash_sale_capacity_movement_control" drop constraint if exists "flash_sale_movement_control_activation_unique";`);
    this.addSql(`alter table if exists "flash_sale_capacity_movement_checkpoint" drop constraint if exists "flash_sale_movement_checkpoint_route_unique";`);
    this.addSql(`alter table if exists "flash_sale_capacity_movement_checkpoint" drop constraint if exists "flash_sale_movement_checkpoint_activation_capacity_unique";`);
    this.addSql(`create table if not exists "flash_sale_capacity_movement_checkpoint" ("id" text not null, "activation_id" text not null, "capacity_id" text not null, "campaign_item_id" text not null, "shard_no" integer not null, "opening_granted_quantity" numeric not null, "opening_available_quantity" numeric not null, "opening_held_quantity" numeric not null, "opening_consumed_quantity" numeric not null, "capacity_version" integer not null, "activated_at" timestamptz not null, "raw_opening_granted_quantity" jsonb not null, "raw_opening_available_quantity" jsonb not null, "raw_opening_held_quantity" jsonb not null, "raw_opening_consumed_quantity" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_capacity_movement_checkpoint_pkey" primary key ("id"), constraint CK_flash_sale_movement_checkpoint_quantities check (opening_granted_quantity > 0 AND opening_available_quantity >= 0 AND opening_held_quantity >= 0 AND opening_consumed_quantity >= 0 AND opening_available_quantity + opening_held_quantity + opening_consumed_quantity = opening_granted_quantity), constraint CK_flash_sale_movement_checkpoint_version check (capacity_version >= 1 AND shard_no >= 0), constraint CK_flash_sale_movement_checkpoint_identity check (char_length(activation_id) BETWEEN 1 AND 255 AND char_length(campaign_item_id) BETWEEN 1 AND 255));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_movement_checkpoint_capacity_id" ON "flash_sale_capacity_movement_checkpoint" ("capacity_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_movement_checkpoint_deleted_at" ON "flash_sale_capacity_movement_checkpoint" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_movement_checkpoint_activation_capacity_unique" ON "flash_sale_capacity_movement_checkpoint" ("activation_id", "capacity_id");`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_movement_checkpoint_route_unique" ON "flash_sale_capacity_movement_checkpoint" ("activation_id", "campaign_item_id", "shard_no");`);

    this.addSql(`create table if not exists "flash_sale_capacity_movement_control" ("id" text not null, "activation_id" text not null, "required_after" timestamptz not null, "schema_version" integer not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_capacity_movement_control_pkey" primary key ("id"), constraint CK_flash_sale_movement_control_singleton check (id = 'allocation-movement-ledger'), constraint CK_flash_sale_movement_control_schema check (schema_version >= 1 AND char_length(activation_id) BETWEEN 1 AND 255));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_movement_control_deleted_at" ON "flash_sale_capacity_movement_control" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_movement_control_activation_unique" ON "flash_sale_capacity_movement_control" ("activation_id");`);

    this.addSql(`create table if not exists "flash_sale_capacity_movement" ("id" text not null, "capacity_id" text not null, "attempt_id" text not null, "campaign_id" text not null, "subject_id" text not null, "campaign_item_id" text not null, "transition_version" integer not null, "kind" text check ("kind" in ('hold', 'consume', 'release', 'expire')) not null, "from_bucket" text check ("from_bucket" in ('available', 'held', 'consumed')) not null, "to_bucket" text check ("to_bucket" in ('available', 'held', 'consumed')) not null, "quantity" numeric not null, "fence_token" text not null, "raw_quantity" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_capacity_movement_pkey" primary key ("id"), constraint CK_flash_sale_movement_transition_version check (transition_version >= 1), constraint CK_flash_sale_movement_quantity check (quantity > 0), constraint CK_flash_sale_movement_fence_token check (fence_token ~ '^[0-9a-f]{64}\$'), constraint CK_flash_sale_movement_bounded_identity check (char_length(campaign_id) BETWEEN 1 AND 255 AND char_length(subject_id) BETWEEN 1 AND 255 AND char_length(campaign_item_id) BETWEEN 1 AND 255), constraint CK_flash_sale_movement_route check ((kind = 'hold' AND from_bucket = 'available' AND to_bucket = 'held') OR (kind = 'consume' AND from_bucket = 'held' AND to_bucket = 'consumed') OR (kind IN ('release', 'expire') AND from_bucket = 'held' AND to_bucket = 'available')));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_movement_capacity_id" ON "flash_sale_capacity_movement" ("capacity_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_movement_attempt_id" ON "flash_sale_capacity_movement" ("attempt_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_movement_deleted_at" ON "flash_sale_capacity_movement" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_movement_attempt_item_transition_unique" ON "flash_sale_capacity_movement" ("attempt_id", "campaign_item_id", "transition_version");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_movement_capacity_created" ON "flash_sale_capacity_movement" ("capacity_id", "created_at", "id") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "flash_sale_capacity_movement_checkpoint" add constraint "flash_sale_capacity_movement_checkpoint_capacity_id_foreign" foreign key ("capacity_id") references "flash_sale_capacity" ("id") on update cascade;`);

    this.addSql(`alter table if exists "flash_sale_capacity_movement" add constraint "flash_sale_capacity_movement_capacity_id_foreign" foreign key ("capacity_id") references "flash_sale_capacity" ("id") on update cascade;`);
    this.addSql(`alter table if exists "flash_sale_capacity_movement" add constraint "flash_sale_capacity_movement_attempt_id_foreign" foreign key ("attempt_id") references "flash_sale_purchase_attempt" ("id") on update cascade;`);
  }

  override async down(): Promise<void> {
    // Generator exception: fail closed rather than silently destroying an
    // activated ledger (including rows hidden by soft deletion). Operators
    // must prove all three physical tables are empty before downgrading.
    this.addSql(`lock table "flash_sale_capacity_movement", "flash_sale_capacity_movement_checkpoint", "flash_sale_capacity_movement_control" in access exclusive mode;`);

    this.addSql(`do $$
      begin
        if exists (select 1 from "flash_sale_capacity_movement" limit 1)
          or exists (select 1 from "flash_sale_capacity_movement_checkpoint" limit 1)
          or exists (select 1 from "flash_sale_capacity_movement_control" limit 1)
        then
          raise exception 'refusing to downgrade non-empty capacity movement ledger';
        end if;
      end
    $$;`);

    this.addSql(`drop table if exists "flash_sale_capacity_movement_checkpoint" cascade;`);

    this.addSql(`drop table if exists "flash_sale_capacity_movement_control" cascade;`);

    this.addSql(`drop table if exists "flash_sale_capacity_movement" cascade;`);
  }

}
