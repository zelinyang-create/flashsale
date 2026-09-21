import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260921060745 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "flash_sale_capacity_movement_control" drop constraint if exists CK_flash_sale_movement_control_schema;`);

    this.addSql(`alter table if exists "flash_sale_capacity_movement_control" add column if not exists "checkpoint_digest" text not null;`);
    this.addSql(`alter table if exists "flash_sale_capacity_movement_control" add constraint CK_flash_sale_movement_control_schema check(schema_version >= 1 AND char_length(activation_id) BETWEEN 1 AND 255 AND checkpoint_digest ~ '^[0-9a-f]{64}\$');`);
  }

  override async down(): Promise<void> {
    // Generator exception: the digest is part of the audit proof. Refuse the
    // first downgrade step before dropping it whenever any physical ledger
    // row exists, including rows hidden by soft deletion.
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

    this.addSql(`alter table if exists "flash_sale_capacity_movement_control" drop constraint if exists CK_flash_sale_movement_control_schema;`);
    this.addSql(`alter table if exists "flash_sale_capacity_movement_control" drop column if exists "checkpoint_digest";`);

    this.addSql(`alter table if exists "flash_sale_capacity_movement_control" add constraint CK_flash_sale_movement_control_schema check(schema_version >= 1 AND char_length(activation_id) BETWEEN 1 AND 255);`);
  }

}
