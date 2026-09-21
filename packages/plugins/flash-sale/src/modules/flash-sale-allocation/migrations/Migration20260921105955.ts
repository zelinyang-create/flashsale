import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260921105955 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_capacity_repair_action" drop constraint if exists "flash_sale_capacity_repair_action_run_capacity_unique";`);
    this.addSql(`alter table if exists "flash_sale_capacity_repair_run" drop constraint if exists "flash_sale_capacity_repair_run_identity_unique";`);
    this.addSql(`create table if not exists "flash_sale_capacity_repair_run" ("id" text not null, "request_identity_digest" text not null, "command_digest" text not null, "campaign_id" text null, "activation_id" text null, "control_schema_version" integer null, "control_root_digest" text null, "status" text not null, "classification" text null, "actor" text not null, "reason" text not null, "ticket" text not null, "evidence_digest" text not null, "issue_codes" jsonb not null, "issue_count" integer not null, "issue_manifest" jsonb not null, "evidence_manifest" jsonb not null, "snapshot_at" timestamptz not null, "finished_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_capacity_repair_run_pkey" primary key ("id"), constraint CK_flash_sale_capacity_repair_run_digests check (request_identity_digest ~ '^[0-9a-f]{64}\$' AND command_digest ~ '^[0-9a-f]{64}\$' AND evidence_digest ~ '^[0-9a-f]{64}\$' AND (control_root_digest IS NULL OR control_root_digest ~ '^[0-9a-f]{64}\$')), constraint CK_flash_sale_capacity_repair_run_bounded check (char_length(actor) BETWEEN 1 AND 255 AND char_length(reason) BETWEEN 1 AND 2000 AND char_length(ticket) BETWEEN 1 AND 255 AND (campaign_id IS NULL OR char_length(campaign_id) BETWEEN 1 AND 255) AND (activation_id IS NULL OR char_length(activation_id) BETWEEN 1 AND 255)), constraint CK_flash_sale_capacity_repair_run_outcome check (((status IN ('not_activated', 'no_changes') AND classification IS NULL) OR (status = 'planned' AND classification IS NOT NULL AND classification = 'safe_repair') OR (status = 'manual_required' AND classification IS NOT NULL AND classification = 'manual_required')) AND issue_count >= 0 AND jsonb_typeof(issue_codes) = 'array' AND jsonb_typeof(issue_manifest) = 'array' AND issue_count = jsonb_array_length(issue_manifest) AND jsonb_typeof(evidence_manifest) = 'object'));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_run_deleted_at" ON "flash_sale_capacity_repair_run" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_run_identity_unique" ON "flash_sale_capacity_repair_run" ("request_identity_digest");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_run_scope_created" ON "flash_sale_capacity_repair_run" ("campaign_id", "created_at", "id");`);

    this.addSql(`alter table if exists "flash_sale_capacity_repair_identity" drop constraint if exists "flash_sale_capacity_repair_identity_run_unique";`);
    this.addSql(`alter table if exists "flash_sale_capacity_repair_identity" drop constraint if exists "flash_sale_capacity_repair_identity_digest_unique";`);
    this.addSql(`create table if not exists "flash_sale_capacity_repair_identity" ("id" text not null, "request_identity_digest" text not null, "run_id" text not null, "command_digest" text not null, "evidence_digest" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_capacity_repair_identity_pkey" primary key ("id"), constraint CK_flash_sale_capacity_repair_identity_digests check (request_identity_digest ~ '^[0-9a-f]{64}\$' AND command_digest ~ '^[0-9a-f]{64}\$' AND evidence_digest ~ '^[0-9a-f]{64}\$'));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_identity_deleted_at" ON "flash_sale_capacity_repair_identity" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_identity_digest_unique" ON "flash_sale_capacity_repair_identity" ("request_identity_digest");`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_identity_run_unique" ON "flash_sale_capacity_repair_identity" ("run_id");`);

    this.addSql(`create table if not exists "flash_sale_capacity_repair_action" ("id" text not null, "run_id" text not null, "capacity_id" text not null, "before_granted_quantity" text not null, "before_held_quantity" text not null, "before_consumed_quantity" text not null, "before_raw_granted_quantity" text not null, "before_raw_held_quantity" text not null, "before_raw_consumed_quantity" text not null, "expected_granted_quantity" text not null, "expected_held_quantity" text not null, "expected_consumed_quantity" text not null, "expected_raw_granted_quantity" text not null, "expected_raw_held_quantity" text not null, "expected_raw_consumed_quantity" text not null, "issue_codes" jsonb not null, "classification" text not null, "evidence_digest" text not null, "status" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_capacity_repair_action_pkey" primary key ("id"), constraint CK_flash_sale_capacity_repair_action_digest check (evidence_digest ~ '^[0-9a-f]{64}\$'), constraint CK_flash_sale_capacity_repair_action_decimal check (before_granted_quantity ~ '^(0|[1-9][0-9]*)\$' AND before_held_quantity ~ '^(0|[1-9][0-9]*)\$' AND before_consumed_quantity ~ '^(0|[1-9][0-9]*)\$' AND before_raw_granted_quantity ~ '^(0|[1-9][0-9]*)\$' AND before_raw_held_quantity ~ '^(0|[1-9][0-9]*)\$' AND before_raw_consumed_quantity ~ '^(0|[1-9][0-9]*)\$' AND expected_granted_quantity ~ '^(0|[1-9][0-9]*)\$' AND expected_held_quantity ~ '^(0|[1-9][0-9]*)\$' AND expected_consumed_quantity ~ '^(0|[1-9][0-9]*)\$' AND expected_raw_granted_quantity ~ '^(0|[1-9][0-9]*)\$' AND expected_raw_held_quantity ~ '^(0|[1-9][0-9]*)\$' AND expected_raw_consumed_quantity ~ '^(0|[1-9][0-9]*)\$'), constraint CK_flash_sale_capacity_repair_action_status check (classification = 'safe_repair' AND status = 'proposed' AND jsonb_typeof(issue_codes) = 'array' AND jsonb_array_length(issue_codes) > 0));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_action_run_id" ON "flash_sale_capacity_repair_action" ("run_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_action_deleted_at" ON "flash_sale_capacity_repair_action" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_action_run_capacity_unique" ON "flash_sale_capacity_repair_action" ("run_id", "capacity_id");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_action_capacity_created" ON "flash_sale_capacity_repair_action" ("capacity_id", "created_at", "id");`);

    this.addSql(`alter table if exists "flash_sale_capacity_repair_action" add constraint "flash_sale_capacity_repair_action_run_id_foreign" foreign key ("run_id") references "flash_sale_capacity_repair_run" ("id") on update cascade;`);
  }

  override async down(): Promise<void> {
    // Generator exception: immutable repair evidence must never disappear via
    // a downgrade, including evidence hidden by soft deletion.
    this.addSql(`lock table "flash_sale_capacity_repair_identity", "flash_sale_capacity_repair_action", "flash_sale_capacity_repair_run" in access exclusive mode;`);
    this.addSql(`do $$
      begin
        if exists (select 1 from "flash_sale_capacity_repair_identity" limit 1)
          or exists (select 1 from "flash_sale_capacity_repair_action" limit 1)
          or exists (select 1 from "flash_sale_capacity_repair_run" limit 1)
        then
          raise exception 'refusing to downgrade non-empty capacity repair audit';
        end if;
      end
    $$;`);

    this.addSql(`alter table if exists "flash_sale_capacity_repair_action" drop constraint if exists "flash_sale_capacity_repair_action_run_id_foreign";`);

    this.addSql(`drop table if exists "flash_sale_capacity_repair_action" cascade;`);

    this.addSql(`drop table if exists "flash_sale_capacity_repair_identity" cascade;`);

    this.addSql(`drop table if exists "flash_sale_capacity_repair_run" cascade;`);
  }

}
