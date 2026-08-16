import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { setAuthAppMetadataStep } from "@medusajs/medusa/core-flows"
import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import createMerchantWorkflow from "../../../workflows/create-merchant"

type CorpsInscription = {
  name: string
  handle: string
  phone: string
  whatsapp_phone?: string
}

const inscrireMarchandWorkflow = createWorkflow(
  "inscrire-marchand",
  (input: CorpsInscription & { auth_identity_id: string }) => {
    // `createMerchantWorkflow` n'accepte que les champs du marchand :
    // lui passer `auth_identity_id` en plus serait une erreur de typage.
    const donneesMarchand = transform(input, (i) => ({
      name: i.name,
      handle: i.handle,
      phone: i.phone,
      whatsapp_phone: i.whatsapp_phone,
    }))

    const provision = createMerchantWorkflow.runAsStep({ input: donneesMarchand })

    setAuthAppMetadataStep({
      authIdentityId: input.auth_identity_id,
      actorType: "merchant",
      value: provision.merchant_id,
    })

    return new WorkflowResponse(provision)
  }
)

export const POST = async (
  req: MedusaRequest<CorpsInscription>,
  res: MedusaResponse
) => {
  const { name, handle, phone, whatsapp_phone } = req.body

  if (!name || !handle || !phone) {
    return res.status(400).json({
      message: "Les champs name, handle et phone sont obligatoires",
    })
  }

  const { result } = await inscrireMarchandWorkflow(req.scope).run({
    input: {
      name,
      handle,
      phone,
      whatsapp_phone,
      auth_identity_id: req.auth_context.auth_identity_id,
    },
  })

  res.json({
    merchant: { id: result.merchant_id, name, handle },
    publishable_key: result.publishable_key,
  })
}
