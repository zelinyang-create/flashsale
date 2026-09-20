import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260920142601 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop constraint if exists "flash_sale_purchase_attempt_state_check";`);

    this.addSql(`alter table if exists "flash_sale_allocation_hold" drop constraint if exists "flash_sale_allocation_hold_state_check";`);

    this.addSql(`alter table if exists "flash_sale_purchase_attempt" add constraint "flash_sale_purchase_attempt_state_check" check("state" in ('pending', 'quota_held', 'quota_rejected', 'quota_consumed', 'quota_released', 'quota_expired'));`);

    this.addSql(`alter table if exists "flash_sale_allocation_hold" add constraint "flash_sale_allocation_hold_state_check" check("state" in ('held', 'consumed', 'released', 'expired'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop constraint if exists "flash_sale_purchase_attempt_state_check";`);

    this.addSql(`alter table if exists "flash_sale_allocation_hold" drop constraint if exists "flash_sale_allocation_hold_state_check";`);

    this.addSql(`alter table if exists "flash_sale_purchase_attempt" add constraint "flash_sale_purchase_attempt_state_check" check("state" in ('pending', 'quota_held', 'quota_rejected', 'quota_consumed', 'quota_released'));`);

    this.addSql(`alter table if exists "flash_sale_allocation_hold" add constraint "flash_sale_allocation_hold_state_check" check("state" in ('held', 'consumed', 'released'));`);
  }

}
