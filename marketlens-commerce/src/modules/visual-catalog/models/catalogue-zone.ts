import { model } from "@medusajs/framework/utils"
import { VisualCatalogue } from "./visual-catalogue"

export const CatalogueZone = model.define("catalogue_zone", {
  id: model.id().primaryKey(),
  // Coordonnées normalisées 0–1000 : x et y sont le centre de la zone.
  // Indépendantes de la résolution, donc valides sur l'image annotée
  // comme sur l'originale.
  x: model.number(),
  y: model.number(),
  width: model.number(),
  height: model.number(),
  detected_label: model.text(),
  detected_category: model.text(),
  catalogue: model.belongsTo(() => VisualCatalogue, { mappedBy: "zones" }),
})
