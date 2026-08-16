import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260816105402 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "merchant" drop constraint if exists "merchant_handle_unique";`);
    this.addSql(`create table if not exists "merchant" ("id" text not null, "name" text not null, "handle" text not null, "phone" text not null, "whatsapp_phone" text null, "currency_code" text not null default 'xof', "status" text check ("status" in ('pending', 'active', 'suspended')) not null default 'pending', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "merchant_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_merchant_handle_unique" ON "merchant" ("handle") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_merchant_deleted_at" ON "merchant" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "merchant" cascade;`);
  }

}
