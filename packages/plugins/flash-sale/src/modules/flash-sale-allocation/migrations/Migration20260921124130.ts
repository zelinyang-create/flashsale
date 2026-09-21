import { Migration } from "@medusajs/framework/mikro-orm/migrations"

const GUARD_ID = "__capacity_repair_3d1_schema_guard__"
const GUARD_RUN_ID = "__capacity_repair_3d1_no_run__"
const GUARD_REQUEST_DIGEST =
  "e779104ac873087f07944c3c5319ee4fac4fb5735c8571080b4f19502052b009"
const GUARD_COMMAND_DIGEST =
  "06b165a9621e493b68521259822e2d62cf73e297d23d782b9e990f749343d585"
const GUARD_EVIDENCE_DIGEST =
  "34d4204efb3978123bad26355611874e82856ac2189709c339a5e2d7b240642d"
const GUARD_AT = "2000-01-01T00:00:00.000Z"

export class Migration20260921124130 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`lock table "flash_sale_capacity_repair_identity", "flash_sale_capacity_repair_run", "flash_sale_capacity_repair_action" in access exclusive mode;`)
    this.addSql(`do $$
      begin
        if to_regclass('public.flash_sale_capacity_repair_apply_identity') is not null then
          execute 'lock table "flash_sale_capacity_repair_apply_identity" in access exclusive mode';
        end if;
        if to_regclass('public.flash_sale_capacity_repair_apply_run') is not null then
          execute 'lock table "flash_sale_capacity_repair_apply_run" in access exclusive mode';
        end if;
        if to_regclass('public.flash_sale_capacity_repair_apply_action') is not null then
          execute 'lock table "flash_sale_capacity_repair_apply_action" in access exclusive mode';
        end if;
      end
    $$;`)

    this.addSql(`alter table "flash_sale_capacity_repair_run" add column if not exists "plan_schema_version" integer null;`)
    this.addSql(`update "flash_sale_capacity_repair_run" set "plan_schema_version" = 1 where "plan_schema_version" is null;`)
    this.addSql(`alter table "flash_sale_capacity_repair_run" alter column "plan_schema_version" set not null;`)
    this.addSql(`alter table "flash_sale_capacity_repair_run" alter column "plan_schema_version" set default 1;`)
    this.addSql(`alter table "flash_sale_capacity_repair_run" drop constraint if exists CK_flash_sale_capacity_repair_run_schema;`)
    this.addSql(`alter table "flash_sale_capacity_repair_run" add constraint CK_flash_sale_capacity_repair_run_schema check (plan_schema_version IN (1, 2));`)

    this.addSql(`alter table "flash_sale_capacity_repair_action" add column if not exists "before_capacity_version" integer null;`)
    this.addSql(`alter table "flash_sale_capacity_repair_action" drop constraint if exists CK_flash_sale_capacity_repair_action_version;`)
    this.addSql(`alter table "flash_sale_capacity_repair_action" add constraint CK_flash_sale_capacity_repair_action_version check (before_capacity_version IS NULL OR before_capacity_version >= 1);`)

    this.addSql(`create table if not exists "flash_sale_capacity_repair_apply_identity" ("id" text not null, "request_identity_digest" text not null, "apply_run_id" text not null, "command_digest" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_capacity_repair_apply_identity_pkey" primary key ("id"), constraint CK_flash_sale_capacity_repair_apply_identity_digests check (request_identity_digest ~ '^[0-9a-f]{64}$' AND command_digest ~ '^[0-9a-f]{64}$'));`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_identity" drop constraint if exists CK_flash_sale_capacity_repair_apply_identity_digests;`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_identity" add constraint CK_flash_sale_capacity_repair_apply_identity_digests check (request_identity_digest ~ '^[0-9a-f]{64}$' AND command_digest ~ '^[0-9a-f]{64}$');`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_apply_identity_deleted_at" ON "flash_sale_capacity_repair_apply_identity" ("deleted_at") WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_apply_identity_digest_unique" ON "flash_sale_capacity_repair_apply_identity" ("request_identity_digest");`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_apply_identity_run_unique" ON "flash_sale_capacity_repair_apply_identity" ("apply_run_id");`)

    this.addSql(`create table if not exists "flash_sale_capacity_repair_apply_run" ("id" text not null, "plan_run_id" text not null, "plan_schema_version" integer not null, "campaign_id" text not null, "command_digest" text not null, "plan_evidence_digest" text not null, "ordered_action_set_digest" text not null, "approval_token_digest" text not null, "approval_claims_digest" text not null, "approval_reference_digest" text not null, "approver" text not null, "approval_issuer" text not null, "approval_audience" text not null, "approval_tenant" text not null, "approval_jti_digest" text not null, "approval_permission_version" text not null, "approval_roles" jsonb not null, "approval_purpose" text not null, "approval_issued_at" timestamptz not null, "approval_not_before" timestamptz not null, "approval_expires_at" timestamptz not null, "requester" text not null, "reason" text not null, "ticket" text not null, "status" text not null, "result_digest" text not null, "finished_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_capacity_repair_apply_run_pkey" primary key ("id"), constraint CK_flash_sale_capacity_repair_apply_run_digests check (command_digest ~ '^[0-9a-f]{64}$' AND plan_evidence_digest ~ '^[0-9a-f]{64}$' AND ordered_action_set_digest ~ '^[0-9a-f]{64}$' AND approval_token_digest ~ '^[0-9a-f]{64}$' AND approval_claims_digest ~ '^[0-9a-f]{64}$' AND approval_reference_digest ~ '^[0-9a-f]{64}$' AND approval_jti_digest ~ '^[0-9a-f]{64}$' AND result_digest ~ '^[0-9a-f]{64}$'), constraint CK_flash_sale_capacity_repair_apply_run_bounded check (char_length(campaign_id) BETWEEN 1 AND 255 AND char_length(approver) BETWEEN 1 AND 255 AND char_length(approval_issuer) BETWEEN 1 AND 255 AND char_length(approval_audience) BETWEEN 1 AND 255 AND char_length(approval_tenant) BETWEEN 1 AND 255 AND char_length(approval_permission_version) BETWEEN 1 AND 255 AND char_length(requester) BETWEEN 1 AND 255 AND char_length(reason) BETWEEN 1 AND 2000 AND char_length(ticket) BETWEEN 1 AND 255 AND approver <> requester), constraint CK_flash_sale_capacity_repair_apply_run_approval_window check (approval_issued_at < approval_expires_at AND approval_not_before < approval_expires_at AND finished_at < approval_expires_at), constraint CK_flash_sale_capacity_repair_apply_run_status check (plan_schema_version = 2 AND status = 'applied' AND approval_purpose = 'capacity_repair_apply' AND jsonb_typeof(approval_roles) = 'array' AND jsonb_array_length(approval_roles) > 0 AND NOT jsonb_path_exists(approval_roles, '$[*] ? (@.type() != "string")')));`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_run" drop constraint if exists CK_flash_sale_capacity_repair_apply_run_digests;`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_run" add constraint CK_flash_sale_capacity_repair_apply_run_digests check (command_digest ~ '^[0-9a-f]{64}$' AND plan_evidence_digest ~ '^[0-9a-f]{64}$' AND ordered_action_set_digest ~ '^[0-9a-f]{64}$' AND approval_token_digest ~ '^[0-9a-f]{64}$' AND approval_claims_digest ~ '^[0-9a-f]{64}$' AND approval_reference_digest ~ '^[0-9a-f]{64}$' AND approval_jti_digest ~ '^[0-9a-f]{64}$' AND result_digest ~ '^[0-9a-f]{64}$');`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_run" drop constraint if exists CK_flash_sale_capacity_repair_apply_run_bounded;`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_run" add constraint CK_flash_sale_capacity_repair_apply_run_bounded check (char_length(campaign_id) BETWEEN 1 AND 255 AND char_length(approver) BETWEEN 1 AND 255 AND char_length(approval_issuer) BETWEEN 1 AND 255 AND char_length(approval_audience) BETWEEN 1 AND 255 AND char_length(approval_tenant) BETWEEN 1 AND 255 AND char_length(approval_permission_version) BETWEEN 1 AND 255 AND char_length(requester) BETWEEN 1 AND 255 AND char_length(reason) BETWEEN 1 AND 2000 AND char_length(ticket) BETWEEN 1 AND 255 AND approver <> requester);`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_run" drop constraint if exists CK_flash_sale_capacity_repair_apply_run_approval_window;`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_run" add constraint CK_flash_sale_capacity_repair_apply_run_approval_window check (approval_issued_at < approval_expires_at AND approval_not_before < approval_expires_at AND finished_at < approval_expires_at);`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_run" drop constraint if exists CK_flash_sale_capacity_repair_apply_run_status;`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_run" add constraint CK_flash_sale_capacity_repair_apply_run_status check (plan_schema_version = 2 AND status = 'applied' AND approval_purpose = 'capacity_repair_apply' AND jsonb_typeof(approval_roles) = 'array' AND jsonb_array_length(approval_roles) > 0 AND NOT jsonb_path_exists(approval_roles, '$[*] ? (@.type() != "string")'));`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_apply_run_plan_run_id" ON "flash_sale_capacity_repair_apply_run" ("plan_run_id") WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_apply_run_deleted_at" ON "flash_sale_capacity_repair_apply_run" ("deleted_at") WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_apply_run_plan_unique" ON "flash_sale_capacity_repair_apply_run" ("plan_run_id");`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_apply_run_approval_jti_unique" ON "flash_sale_capacity_repair_apply_run" ("approval_jti_digest");`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_apply_run_ticket_created" ON "flash_sale_capacity_repair_apply_run" ("ticket", "created_at", "id");`)

    this.addSql(`create table if not exists "flash_sale_capacity_repair_apply_action" ("id" text not null, "apply_run_id" text not null, "plan_action_id" text not null, "capacity_id" text not null, "before_capacity_version" integer not null, "after_capacity_version" integer not null, "before_granted_quantity" text not null, "before_held_quantity" text not null, "before_consumed_quantity" text not null, "before_raw_granted_quantity" text not null, "before_raw_held_quantity" text not null, "before_raw_consumed_quantity" text not null, "after_granted_quantity" text not null, "after_held_quantity" text not null, "after_consumed_quantity" text not null, "after_raw_granted_quantity" text not null, "after_raw_held_quantity" text not null, "after_raw_consumed_quantity" text not null, "evidence_digest" text not null, "status" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "flash_sale_capacity_repair_apply_action_pkey" primary key ("id"), constraint CK_flash_sale_capacity_repair_apply_action_version check (before_capacity_version >= 1 AND after_capacity_version = before_capacity_version + 1), constraint CK_flash_sale_capacity_repair_apply_action_decimal check (before_granted_quantity ~ '^(0|[1-9][0-9]*)$' AND before_held_quantity ~ '^(0|[1-9][0-9]*)$' AND before_consumed_quantity ~ '^(0|[1-9][0-9]*)$' AND before_raw_granted_quantity ~ '^(0|[1-9][0-9]*)$' AND before_raw_held_quantity ~ '^(0|[1-9][0-9]*)$' AND before_raw_consumed_quantity ~ '^(0|[1-9][0-9]*)$' AND after_granted_quantity ~ '^(0|[1-9][0-9]*)$' AND after_held_quantity ~ '^(0|[1-9][0-9]*)$' AND after_consumed_quantity ~ '^(0|[1-9][0-9]*)$' AND after_raw_granted_quantity ~ '^(0|[1-9][0-9]*)$' AND after_raw_held_quantity ~ '^(0|[1-9][0-9]*)$' AND after_raw_consumed_quantity ~ '^(0|[1-9][0-9]*)$'), constraint CK_flash_sale_capacity_repair_apply_action_invariants check (status = 'applied' AND evidence_digest ~ '^[0-9a-f]{64}$' AND before_granted_quantity = after_granted_quantity AND before_granted_quantity = before_raw_granted_quantity AND after_granted_quantity = after_raw_granted_quantity AND after_held_quantity = after_raw_held_quantity AND after_consumed_quantity = after_raw_consumed_quantity AND before_held_quantity::numeric + before_consumed_quantity::numeric <= before_granted_quantity::numeric AND after_held_quantity::numeric + after_consumed_quantity::numeric <= after_granted_quantity::numeric));`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_action" drop constraint if exists CK_flash_sale_capacity_repair_apply_action_version;`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_action" add constraint CK_flash_sale_capacity_repair_apply_action_version check (before_capacity_version >= 1 AND after_capacity_version = before_capacity_version + 1);`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_action" drop constraint if exists CK_flash_sale_capacity_repair_apply_action_decimal;`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_action" add constraint CK_flash_sale_capacity_repair_apply_action_decimal check (before_granted_quantity ~ '^(0|[1-9][0-9]*)$' AND before_held_quantity ~ '^(0|[1-9][0-9]*)$' AND before_consumed_quantity ~ '^(0|[1-9][0-9]*)$' AND before_raw_granted_quantity ~ '^(0|[1-9][0-9]*)$' AND before_raw_held_quantity ~ '^(0|[1-9][0-9]*)$' AND before_raw_consumed_quantity ~ '^(0|[1-9][0-9]*)$' AND after_granted_quantity ~ '^(0|[1-9][0-9]*)$' AND after_held_quantity ~ '^(0|[1-9][0-9]*)$' AND after_consumed_quantity ~ '^(0|[1-9][0-9]*)$' AND after_raw_granted_quantity ~ '^(0|[1-9][0-9]*)$' AND after_raw_held_quantity ~ '^(0|[1-9][0-9]*)$' AND after_raw_consumed_quantity ~ '^(0|[1-9][0-9]*)$');`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_action" drop constraint if exists CK_flash_sale_capacity_repair_apply_action_invariants;`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_action" add constraint CK_flash_sale_capacity_repair_apply_action_invariants check (status = 'applied' AND evidence_digest ~ '^[0-9a-f]{64}$' AND before_granted_quantity = after_granted_quantity AND before_granted_quantity = before_raw_granted_quantity AND after_granted_quantity = after_raw_granted_quantity AND after_held_quantity = after_raw_held_quantity AND after_consumed_quantity = after_raw_consumed_quantity AND before_held_quantity::numeric + before_consumed_quantity::numeric <= before_granted_quantity::numeric AND after_held_quantity::numeric + after_consumed_quantity::numeric <= after_granted_quantity::numeric);`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_apply_action_apply_run_id" ON "flash_sale_capacity_repair_apply_action" ("apply_run_id") WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_apply_action_plan_action_id" ON "flash_sale_capacity_repair_apply_action" ("plan_action_id") WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_apply_action_deleted_at" ON "flash_sale_capacity_repair_apply_action" ("deleted_at") WHERE deleted_at IS NULL;`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_apply_action_plan_unique" ON "flash_sale_capacity_repair_apply_action" ("plan_action_id");`)
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_capacity_repair_apply_action_run_capacity_unique" ON "flash_sale_capacity_repair_apply_action" ("apply_run_id", "capacity_id");`)

    this.addSql(`alter table "flash_sale_capacity_repair_apply_run" drop constraint if exists "flash_sale_capacity_repair_apply_run_plan_run_id_foreign";`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_run" add constraint "flash_sale_capacity_repair_apply_run_plan_run_id_foreign" foreign key ("plan_run_id") references "flash_sale_capacity_repair_run" ("id") on update cascade on delete no action;`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_action" drop constraint if exists "flash_sale_capacity_repair_apply_action_apply_run_id_foreign";`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_action" add constraint "flash_sale_capacity_repair_apply_action_apply_run_id_foreign" foreign key ("apply_run_id") references "flash_sale_capacity_repair_apply_run" ("id") on update cascade on delete no action;`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_action" drop constraint if exists "flash_sale_capacity_repair_apply_action_plan_action_id_foreign";`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_action" add constraint "flash_sale_capacity_repair_apply_action_plan_action_id_foreign" foreign key ("plan_action_id") references "flash_sale_capacity_repair_action" ("id") on update cascade on delete no action;`)

    this.addSql(`do $$
      declare candidate_count integer;
      declare exact_count integer;
      begin
        select count(*), count(*) filter (where
          id = '${GUARD_ID}' and request_identity_digest = '${GUARD_REQUEST_DIGEST}'
          and run_id = '${GUARD_RUN_ID}' and command_digest = '${GUARD_COMMAND_DIGEST}'
          and evidence_digest = '${GUARD_EVIDENCE_DIGEST}'
          and created_at = '${GUARD_AT}'::timestamptz
          and updated_at = '${GUARD_AT}'::timestamptz
          and deleted_at = '${GUARD_AT}'::timestamptz)
          into candidate_count, exact_count
          from flash_sale_capacity_repair_identity
         where id = '${GUARD_ID}'
            or request_identity_digest = '${GUARD_REQUEST_DIGEST}'
            or run_id = '${GUARD_RUN_ID}';
        if candidate_count = 0 then
          insert into flash_sale_capacity_repair_identity
            (id, request_identity_digest, run_id, command_digest,
             evidence_digest, created_at, updated_at, deleted_at)
          values ('${GUARD_ID}', '${GUARD_REQUEST_DIGEST}', '${GUARD_RUN_ID}',
                  '${GUARD_COMMAND_DIGEST}', '${GUARD_EVIDENCE_DIGEST}',
                  '${GUARD_AT}', '${GUARD_AT}', '${GUARD_AT}');
        elsif candidate_count <> 1 or exact_count <> 1 then
          raise exception 'capacity repair 3d-1 schema guard conflicts or drifted';
        end if;
      end
    $$;`)
  }

  override async down(): Promise<void> {
    this.addSql(`lock table "flash_sale_capacity_repair_identity", "flash_sale_capacity_repair_run", "flash_sale_capacity_repair_action", "flash_sale_capacity_repair_apply_identity", "flash_sale_capacity_repair_apply_run", "flash_sale_capacity_repair_apply_action" in access exclusive mode;`)
    this.addSql(`do $$
      declare exact_guard_count integer;
      begin
        if exists (select 1 from flash_sale_capacity_repair_apply_identity limit 1)
          or exists (select 1 from flash_sale_capacity_repair_apply_run limit 1)
          or exists (select 1 from flash_sale_capacity_repair_apply_action limit 1)
        then
          raise exception 'refusing to downgrade non-empty capacity repair Apply audit';
        end if;
        if exists (select 1 from flash_sale_capacity_repair_run where plan_schema_version <> 1 limit 1)
          or exists (select 1 from flash_sale_capacity_repair_action where before_capacity_version is not null limit 1)
          or exists (
            select 1 from flash_sale_capacity_repair_identity identity_row
            left join flash_sale_capacity_repair_run run_row on run_row.id = identity_row.run_id
            where identity_row.id <> '${GUARD_ID}'
              and (run_row.id is null or run_row.plan_schema_version <> 1)
            limit 1)
          or exists (
            select 1 from flash_sale_capacity_repair_run run_row
            left join flash_sale_capacity_repair_identity identity_row
              on identity_row.run_id = run_row.id
             and identity_row.id <> '${GUARD_ID}'
            where identity_row.id is null
            limit 1)
        then
          raise exception 'refusing to downgrade schema-v2 or ambiguous capacity repair Plan audit';
        end if;
        select count(*) into exact_guard_count
          from flash_sale_capacity_repair_identity
         where id = '${GUARD_ID}' and request_identity_digest = '${GUARD_REQUEST_DIGEST}'
           and run_id = '${GUARD_RUN_ID}' and command_digest = '${GUARD_COMMAND_DIGEST}'
           and evidence_digest = '${GUARD_EVIDENCE_DIGEST}'
           and created_at = '${GUARD_AT}'::timestamptz
           and updated_at = '${GUARD_AT}'::timestamptz
           and deleted_at = '${GUARD_AT}'::timestamptz;
        if exact_guard_count <> 1 then
          raise exception 'capacity repair 3d-1 schema guard missing or drifted';
        end if;
        delete from flash_sale_capacity_repair_identity where id = '${GUARD_ID}';
      end
    $$;`)

    this.addSql(`alter table "flash_sale_capacity_repair_apply_action" drop constraint if exists "flash_sale_capacity_repair_apply_action_plan_action_id_foreign";`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_action" drop constraint if exists "flash_sale_capacity_repair_apply_action_apply_run_id_foreign";`)
    this.addSql(`alter table "flash_sale_capacity_repair_apply_run" drop constraint if exists "flash_sale_capacity_repair_apply_run_plan_run_id_foreign";`)
    this.addSql(`drop table "flash_sale_capacity_repair_apply_action";`)
    this.addSql(`drop table "flash_sale_capacity_repair_apply_run";`)
    this.addSql(`drop table "flash_sale_capacity_repair_apply_identity";`)
    this.addSql(`alter table "flash_sale_capacity_repair_action" drop constraint if exists CK_flash_sale_capacity_repair_action_version;`)
    this.addSql(`alter table "flash_sale_capacity_repair_action" drop column "before_capacity_version";`)
    this.addSql(`alter table "flash_sale_capacity_repair_run" drop constraint if exists CK_flash_sale_capacity_repair_run_schema;`)
    this.addSql(`alter table "flash_sale_capacity_repair_run" drop column "plan_schema_version";`)
  }
}
