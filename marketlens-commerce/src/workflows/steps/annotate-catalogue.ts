import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ProduitAnnote, annoterImage } from "../../lib/vision-client"

export type AnnotateCatalogueInput = {
  content: string
  filename: string
  produits: ProduitAnnote[]
}

/** Lecture pure côté vision : rien à compenser. Le fichier annoté est
 *  déposé par l'étape suivante, qui porte sa propre compensation. */
export const annotateCatalogueStep = createStep(
  "annotate-catalogue",
  async (input: AnnotateCatalogueInput) => {
    const octets = await annoterImage(
      Buffer.from(input.content, "binary"),
      input.filename,
      input.produits
    )
    return new StepResponse(octets.toString("binary"))
  }
)
