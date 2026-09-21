import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260921064136 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_capacity_movement_checkpoint" add column if not exists "checkpoint_kind" text check ("checkpoint_kind" in ('cutover', 'provision')) not null default 'cutover';`);
  }

  override async down(): Promise<void> {
    // Generator exception: checkpoint_kind is required to interpret a rolling
    // root. Refuse to erase it while any physical ledger evidence exists.
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

    this.addSql(`alter table if exists "flash_sale_capacity_movement_checkpoint" drop column if exists "checkpoint_kind";`);
  }

}
