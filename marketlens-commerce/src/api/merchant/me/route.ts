import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MERCHANT_MODULE } from "../../../modules/merchant"

export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const merchantId = req.auth_context.actor_id

  if (!merchantId) {
    return res.status(401).json({ message: "Identité non rattachée à un marchand" })
  }

  const service: any = req.scope.resolve(MERCHANT_MODULE)
  const marchand = await service.retrieveMerchant(merchantId)

  res.json({ merchant: marchand })
}
