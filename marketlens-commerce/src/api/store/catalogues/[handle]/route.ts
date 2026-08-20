import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data } = await query.graph({
    entity: "visual_catalogue",
    fields: [
      "id", "handle", "title", "annotated_image_url", "status",
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
    return res.status(404).json({ message: "Catalogue introuvable" })
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
