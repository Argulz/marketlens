import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export type VerifierCatalogueMarchandInput = {
  catalogue_id: string
  merchant_id: string
}

export type VerifierCatalogueMarchandOutput = {
  merchant_handle: string
}

/** Lecture pure, sans compensation : confirme que le catalogue appartient
 *  bien au marchand indiqué, via le lien `merchant-visual-catalogue`, avant
 *  toute écriture. Sans ce contrôle, le workflow publierait n'importe quel
 *  catalogue dans le canal de vente fourni — `merchant_id` ne serait alors
 *  qu'un paramètre décoratif. Fournit au passage le handle du marchand, qui
 *  préfixe les handles produit (voir publish-catalogue.ts). */
export const verifierCatalogueMarchandStep = createStep(
  "verifier-catalogue-marchand",
  async (input: VerifierCatalogueMarchandInput, { container }) => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const { data } = await query.graph({
      entity: "merchant",
      fields: ["id", "handle", "visual_catalogues.id"],
      filters: { id: input.merchant_id },
    })

    const marchand = data[0] as unknown as
      | { id: string; handle: string; visual_catalogues: { id: string }[] }
      | undefined
    const possede = marchand?.visual_catalogues?.some((c) => c.id === input.catalogue_id) ?? false

    if (!marchand || !possede) {
      throw new Error("Ce catalogue n'appartient pas à ce marchand.")
    }

    return new StepResponse<VerifierCatalogueMarchandOutput>({ merchant_handle: marchand.handle })
  }
)
