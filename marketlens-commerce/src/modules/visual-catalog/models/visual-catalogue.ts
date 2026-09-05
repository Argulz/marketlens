import { model } from "@medusajs/framework/utils"
import { CatalogueZone } from "./catalogue-zone"

export const VisualCatalogue = model.define("visual_catalogue", {
  id: model.id().primaryKey(),
  handle: model.text().unique(),
  title: model.text(),
  source_image_url: model.text(),
  // Identifiant de fichier de la photo d'origine, tel que rendu par le
  // module File (`createFiles` renvoie `id = key`) : c'est ce que
  // `getAsBuffer(id)` attend, et non l'URL. Le déduire de
  // `source_image_url` ne marche qu'avec le fournisseur local et casserait
  // avec un fournisseur distant (S3), dont les URLs ne portent pas la clé.
  //
  // NULLABLE, et c'est délibéré : les catalogues créés avant cette colonne
  // (les 28 du corpus, ceux des démonstrations) ne l'ont pas et doivent
  // rester lisibles. Leur seule limite est qu'on ne peut plus régénérer
  // leur image annotée — ce que `ErreurImageSourceIndisponible` dit en
  // français plutôt que de planter.
  source_image_id: model.text().nullable(),
  annotated_image_url: model.text().nullable(),
  status: model.enum(["draft", "published"]).default("draft"),
  zones: model.hasMany(() => CatalogueZone, { mappedBy: "catalogue" }),
})
