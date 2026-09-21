import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260921071902 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" add column if not exists "hold_movement_activation_id" text null, add column if not exists "terminal_movement_activation_id" text null;`);
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" add constraint CK_flash_sale_attempt_hold_movement_activation check(hold_movement_activation_id IS NULL OR char_length(hold_movement_activation_id) BETWEEN 1 AND 255);`);
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" add constraint CK_flash_sale_attempt_terminal_movement_activation check(terminal_movement_activation_id IS NULL OR char_length(terminal_movement_activation_id) BETWEEN 1 AND 255);`);
  }

  override async down(): Promise<void> {
    // Generator exception: these bindings are the durable proof deciding
    // whether replay must require or forbid Movement rows.
    this.addSql(`lock table "flash_sale_purchase_attempt", "flash_sale_capacity_movement", "flash_sale_capacity_movement_checkpoint", "flash_sale_capacity_movement_control" in access exclusive mode;`);
    this.addSql(`do $$
      begin
        if exists (select 1 from "flash_sale_capacity_movement" limit 1)
          or exists (select 1 from "flash_sale_capacity_movement_checkpoint" limit 1)
          or exists (select 1 from "flash_sale_capacity_movement_control" limit 1)
          or exists (select 1 from "flash_sale_purchase_attempt"
                      where hold_movement_activation_id is not null
                         or terminal_movement_activation_id is not null
                      limit 1)
        then
          raise exception 'refusing to downgrade non-empty capacity movement ledger';
        end if;
      end
    $$;`);

    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop constraint if exists CK_flash_sale_attempt_hold_movement_activation;`);
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop constraint if exists CK_flash_sale_attempt_terminal_movement_activation;`);
    this.addSql(`alter table if exists "flash_sale_purchase_attempt" drop column if exists "hold_movement_activation_id", drop column if exists "terminal_movement_activation_id";`);
  }

}
