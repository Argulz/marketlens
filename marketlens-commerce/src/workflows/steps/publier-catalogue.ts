import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { VISUAL_CATALOG_MODULE } from "../../modules/visual-catalog"
import VisualCatalogModuleService from "../../modules/visual-catalog/service"

export type PublierCatalogueInput = {
  catalogue_id: string
  annotated_image_url: string
}

export const publierCatalogueStep = createStep(
  "publier-catalogue",
  async (input: PublierCatalogueInput, { container }) => {
    const service = container.resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
    const avant = await service.retrieveVisualCatalogue(input.catalogue_id)

    const apres = await service.updateVisualCatalogues({
      id: input.catalogue_id,
      annotated_image_url: input.annotated_image_url,
      status: "published",
    })

    // La compensation restaure l'état exact d'avant, pas un état supposé.
    return new StepResponse(apres, {
      catalogue_id: input.catalogue_id,
      status: avant.status,
      annotated_image_url: avant.annotated_image_url,
    })
  },
  async (etatPrecedent, { container }) => {
    if (!etatPrecedent) return
    const service = container.resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
    await service.updateVisualCatalogues({
      id: etatPrecedent.catalogue_id,
      status: etatPrecedent.status,
      annotated_image_url: etatPrecedent.annotated_image_url,
    })
  }
)
