import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260920162302 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop constraint if exists "flash_sale_attempt_live_cart_settlement_unique";`);
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop constraint if exists "flash_sale_purchase_attempt_state_check";`);

    this.addSql(`drop index if exists "IDX_flash_sale_attempt_live_cart_unique";`);

    this.addSql(`alter table if exists "flash_sale_purchase_attempt" add column if not exists "settlement_id" text null, add column if not exists "settlement_started_at" timestamptz null;`);
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" add constraint "flash_sale_purchase_attempt_state_check" check("state" in ('pending', 'quota_held', 'quota_committing', 'quota_rejected', 'quota_consumed', 'quota_released', 'quota_expired'));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_attempt_live_cart_settlement_unique" ON "flash_sale_purchase_attempt" ("campaign_id", "cart_id") WHERE deleted_at IS NULL AND cart_id IS NOT NULL AND state IN ('pending', 'quota_held', 'quota_committing');`);
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" add constraint CK_flash_sale_attempt_settlement_pair check((settlement_id IS NULL) = (settlement_started_at IS NULL));`);
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" add constraint CK_flash_sale_attempt_committing_settlement check(state <> 'quota_committing' OR (settlement_id IS NOT NULL AND settlement_started_at IS NOT NULL));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop constraint if exists "flash_sale_purchase_attempt_state_check";`);

    this.addSql(`drop index if exists "IDX_flash_sale_attempt_live_cart_settlement_unique";`);
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop constraint if exists CK_flash_sale_attempt_settlement_pair;`);
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop constraint if exists CK_flash_sale_attempt_committing_settlement;`);
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop column if exists "settlement_id", drop column if exists "settlement_started_at";`);

    this.addSql(`alter table if exists "flash_sale_purchase_attempt" add constraint "flash_sale_purchase_attempt_state_check" check("state" in ('pending', 'quota_held', 'quota_rejected', 'quota_consumed', 'quota_released', 'quota_expired'));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_flash_sale_attempt_live_cart_unique" ON "flash_sale_purchase_attempt" ("campaign_id", "cart_id") WHERE deleted_at IS NULL AND cart_id IS NOT NULL AND state IN ('pending', 'quota_held');`);
  }

}
