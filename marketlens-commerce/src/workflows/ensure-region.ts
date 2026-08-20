import { createRegionsWorkflow } from "@medusajs/medusa/core-flows"
import { MedusaContainer } from "@medusajs/framework/types"

export const NOM_REGION_XOF = "Afrique de l'Ouest (XOF)"

/**
 * Les prix Medusa vivent dans une devise portée par une région ; sans région
 * XOF, la vitrine ne peut afficher aucun prix. Idempotent : appelable à
 * chaque publication sans créer de doublon.
 */
export async function assurerRegionXof(container: MedusaContainer): Promise<string> {
  const query = container.resolve("query")
  const { data } = await query.graph({
    entity: "region",
    fields: ["id", "currency_code"],
    filters: { currency_code: "xof" },
  })

  if (data.length > 0) {
    return data[0].id
  }

  const { result } = await createRegionsWorkflow(container).run({
    input: { regions: [{ name: NOM_REGION_XOF, currency_code: "xof", countries: ["bj"] }] },
  })
  return result[0].id
}
