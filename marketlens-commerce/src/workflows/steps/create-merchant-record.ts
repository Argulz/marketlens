import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MERCHANT_MODULE } from "../../modules/merchant"

export type CreateMerchantRecordInput = {
  name: string
  handle: string
  phone: string
  whatsapp_phone?: string
}

export const createMerchantRecordStep = createStep(
  "create-merchant-record",
  async (input: CreateMerchantRecordInput, { container }) => {
    const service: any = container.resolve(MERCHANT_MODULE)
    const marchand = await service.createMerchants({
      name: input.name,
      handle: input.handle,
      phone: input.phone,
      whatsapp_phone: input.whatsapp_phone ?? null,
    })
    return new StepResponse(marchand, marchand.id)
  },
  async (merchantId: string | undefined, { container }) => {
    if (!merchantId) return
    const service: any = container.resolve(MERCHANT_MODULE)
    await service.deleteMerchants([merchantId])
  }
)
