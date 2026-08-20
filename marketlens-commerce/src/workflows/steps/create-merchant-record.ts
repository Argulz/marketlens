import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MERCHANT_MODULE } from "../../modules/merchant"
import MerchantModuleService from "../../modules/merchant/service"

export type CreateMerchantRecordInput = {
  name: string
  handle: string
  phone: string
  whatsapp_phone?: string
}

// `handle` est destiné à devenir un segment d'URL publique (`/c/<handle>`).
// La route d'inscription (src/api/merchant/register/route.ts) normalise déjà
// ce champ avant d'appeler le workflow, mais cette validation ne protège que
// cette route : tout appel direct au workflow — script d'opérateur, autre
// workflow, script d'import du corpus — persisterait un handle brut. L'index
// unique de Postgres est sensible à la casse, donc `etal-fatou` et
// `ETAL-FATOU` se disputeraient la même URL de catalogue sans cette
// normalisation posée ici, au plus près de la persistance.
const MOTIF_HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function normaliserHandle(brut: string): string {
  const handle = brut.trim().toLowerCase()
  if (!MOTIF_HANDLE.test(handle)) {
    throw new Error(
      `Le handle « ${brut} » doit être composé de lettres minuscules, de ` +
      `chiffres et de tirets simples`
    )
  }
  return handle
}

export const createMerchantRecordStep = createStep(
  "create-merchant-record",
  async (input: CreateMerchantRecordInput, { container }) => {
    const service = container.resolve<MerchantModuleService>(MERCHANT_MODULE)
    const marchand = await service.createMerchants({
      name: input.name,
      handle: normaliserHandle(input.handle),
      phone: input.phone,
      whatsapp_phone: input.whatsapp_phone ?? null,
      // Le modèle DML pose `pending` par défaut, mais rien dans le socle ne
      // fait ensuite passer un marchand à `active` : un marchand provisionné
      // par ce workflow est opérationnel dès la fin de la transaction, donc
      // le statut est posé explicitement ici. `pending` reste la valeur par
      // défaut du modèle pour toute création qui ne passe pas par ce
      // workflow (import, script d'opérateur), et `/merchant/me` refuse tout
      // marchand qui n'est pas `active`.
      status: "active",
    })
    return new StepResponse(marchand, marchand.id)
  },
  async (merchantId: string | undefined, { container }) => {
    if (!merchantId) return
    const service = container.resolve<MerchantModuleService>(MERCHANT_MODULE)
    await service.deleteMerchants([merchantId])
  }
)
