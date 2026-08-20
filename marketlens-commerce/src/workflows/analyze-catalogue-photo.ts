import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import { uploadFilesWorkflow, createRemoteLinkStep } from "@medusajs/medusa/core-flows"
import { MERCHANT_MODULE } from "../modules/merchant"
import { VISUAL_CATALOG_MODULE } from "../modules/visual-catalog"
import { detectProductsStep } from "./steps/detect-products"
import { createCatalogueDraftStep } from "./steps/create-catalogue-draft"

export type AnalyzeCataloguePhotoInput = {
  merchant_id: string
  filename: string
  content: string
  title: string
}

// La détection ne crée aucune donnée commerciale : ce workflow produit un
// brouillon de catalogue et ses zones détectées, jamais de produit. C'est
// la publication (tâche 6) qui crée les vrais produits, à partir des zones
// que le marchand aura corrigées.
const analyzeCataloguePhotoWorkflow = createWorkflow(
  "analyze-catalogue-photo",
  (input: AnalyzeCataloguePhotoInput) => {
    const fichiers = uploadFilesWorkflow.runAsStep({
      input: {
        files: [
          transform(input, (i) => ({
            filename: i.filename,
            mimeType: "image/jpeg",
            content: i.content,
            // Image de vitrine : la doc du type recommande `public` pour
            // tout fichier destiné à être affiché côté storefront.
            access: "public" as const,
          })),
        ],
      },
    })

    const zones = detectProductsStep(
      transform(input, (i) => ({ content: i.content, filename: i.filename }))
    )

    const donneesBrouillon = transform(
      { input, fichiers, zones },
      (d) => ({
        title: d.input.title,
        source_image_url: d.fichiers[0].url,
        zones: d.zones,
      })
    )

    const catalogue = createCatalogueDraftStep(donneesBrouillon)

    // Comme dans create-merchant.ts : un accès direct de propriété sur une
    // référence différée (`input.merchant_id`, `catalogue.catalogue_id`)
    // est sûr dans un littéral d'objet — seule l'interpolation dans un
    // gabarit de chaîne est piégeuse. Envelopper ce littéral dans
    // `transform()` casse au contraire l'inférence de type de
    // `LinkDefinition`.
    createRemoteLinkStep([
      {
        [MERCHANT_MODULE]: { merchant_id: input.merchant_id },
        [VISUAL_CATALOG_MODULE]: { visual_catalogue_id: catalogue.catalogue_id },
      },
    ])

    return new WorkflowResponse(
      transform({ catalogue }, (d) => ({
        catalogue_id: d.catalogue.catalogue_id,
        handle: d.catalogue.handle,
        zones: d.catalogue.zones,
      }))
    )
  }
)

export default analyzeCataloguePhotoWorkflow
