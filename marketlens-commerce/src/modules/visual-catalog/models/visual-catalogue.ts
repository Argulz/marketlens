import { model } from "@medusajs/framework/utils"
import { CatalogueZone } from "./catalogue-zone"

export const VisualCatalogue = model.define("visual_catalogue", {
  id: model.id().primaryKey(),
  handle: model.text().unique(),
  title: model.text(),
  source_image_url: model.text(),
  annotated_image_url: model.text().nullable(),
  status: model.enum(["draft", "published"]).default("draft"),
  zones: model.hasMany(() => CatalogueZone, { mappedBy: "catalogue" }),
})
