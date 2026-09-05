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
        // `id` est la CLÉ du fichier telle que le module File la rend
        // (`createFiles` : `id = file.key`) — la seule valeur que
        // `getAsBuffer` accepte. On la persiste dès la création du
        // brouillon : c'est ce qui permet, plus tard, de relire la photo
        // d'origine pour la réannoter sans repasser par la détection.
        source_image_id: d.fichiers[0].id,
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
        source_image_id: d.catalogue.source_image_id,
        zones: d.catalogue.zones,
      }))
    )
  }
)

export default analyzeCataloguePhotoWorkflow
