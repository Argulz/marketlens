import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { marchandEstActif } from "../../../merchant/catalogues/scope"

// Un catalogue introuvable, un brouillon, et un catalogue publié par un
// marchand suspendu rendent tous EXACTEMENT cette réponse : la vitrine ne
// révèle ni l'existence du catalogue ni la raison du refus. Un 403 sur un
// marchand suspendu confirmerait au visiteur que le catalogue existe et que
// son propriétaire a été coupé.
const REPONSE_INTROUVABLE = { message: "Catalogue introuvable" }

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data } = await query.graph({
    entity: "visual_catalogue",
    fields: [
      "id", "handle", "title", "annotated_image_url", "status",
      // Le marchand est remonté par le lien `merchant` → `visual_catalogue`
      // (src/links/merchant-visual-catalogue.ts). Le lien est déclaré
      // `isList: true` du côté catalogue, donc le champ inverse est
      // SINGULIER (`merchant`) : un catalogue appartient à un marchand. Le
      // pluriel (`merchants`) est accepté sans erreur par query.graph mais
      // ne renvoie rien du tout — vérifié directement contre cette base,
      // d'où l'absence de tolérance ci-dessous sur un marchand manquant.
      "merchant.id", "merchant.status",
      "zones.id", "zones.x", "zones.y", "zones.width", "zones.height",
      "zones.detected_label", "zones.detected_category",
      // Champ singulier côté zone (tâche 3) : une zone porte au plus un
      // produit publié.
      "zones.product.id", "zones.product.title", "zones.product.description",
      "zones.product.variants.id", "zones.product.variants.title",
    ],
    filters: { handle: req.params.handle, status: "published" },
  })

  const catalogue = data[0] as any
  if (!catalogue) {
    // Un brouillon est indiscernable d'un catalogue inexistant : le filtre
    // `status: "published"` ci-dessus fait partie du cloisonnement, pas du
    // confort — un marchand n'a validé que l'image annotée, jamais son
    // brouillon.
    return res.status(404).json(REPONSE_INTROUVABLE)
  }

  // « Une vitrine publiée par un marchand suspendu ne doit pas rester
  // servie » (notes-plan-3). Le catalogue reste `published` en base — la
  // suspension n'est pas une dépublication — mais il cesse d'être servi
  // tant que le marchand n'est pas `active`. Un marchand absent (lien
  // manquant, marchand supprimé) tombe dans la même branche : sans
  // propriétaire actif identifiable, rien n'est servi.
  if (!marchandEstActif(catalogue.merchant?.status)) {
    return res.status(404).json(REPONSE_INTROUVABLE)
  }

  res.json({
    catalogue: {
      handle: catalogue.handle,
      title: catalogue.title,
      // `source_image_url` n'est jamais exposé ici : la vitrine ne montre
      // que l'image annotée, celle que le marchand a validée avant
      // publication.
      annotated_image_url: catalogue.annotated_image_url,
    },
    zones: catalogue.zones,
  })
}
