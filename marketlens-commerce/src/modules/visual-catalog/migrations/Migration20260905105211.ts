import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260905105211 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "visual_catalogue" add column if not exists "source_image_id" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "visual_catalogue" drop column if exists "source_image_id";`);
  }

}
