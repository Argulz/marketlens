import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260820101521 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "visual_catalogue" drop constraint if exists "visual_catalogue_handle_unique";`);
    this.addSql(`create table if not exists "visual_catalogue" ("id" text not null, "handle" text not null, "title" text not null, "source_image_url" text not null, "annotated_image_url" text null, "status" text check ("status" in ('draft', 'published')) not null default 'draft', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "visual_catalogue_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_visual_catalogue_handle_unique" ON "visual_catalogue" ("handle") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_visual_catalogue_deleted_at" ON "visual_catalogue" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "catalogue_zone" ("id" text not null, "x" integer not null, "y" integer not null, "width" integer not null, "height" integer not null, "detected_label" text not null, "detected_category" text not null, "catalogue_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "catalogue_zone_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_catalogue_zone_catalogue_id" ON "catalogue_zone" ("catalogue_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_catalogue_zone_deleted_at" ON "catalogue_zone" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "catalogue_zone" add constraint "catalogue_zone_catalogue_id_foreign" foreign key ("catalogue_id") references "visual_catalogue" ("id") on update cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "catalogue_zone" drop constraint if exists "catalogue_zone_catalogue_id_foreign";`);

    this.addSql(`drop table if exists "visual_catalogue" cascade;`);

    this.addSql(`drop table if exists "catalogue_zone" cascade;`);
  }

}
