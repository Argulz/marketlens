import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import {
  createSalesChannelsWorkflow,
  createStockLocationsWorkflow,
  createApiKeysWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  createRemoteLinkStep,
} from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/framework/utils"
import { MERCHANT_MODULE } from "../modules/merchant"
import { createMerchantRecordStep, CreateMerchantRecordInput } from "./steps/create-merchant-record"

const createMerchantWorkflow = createWorkflow(
  "create-merchant",
  (input: CreateMerchantRecordInput) => {
    const marchand = createMerchantRecordStep(input)

    // `input.name` est une référence différée (proxy) ; l'interpoler directement
    // dans un template string ferait échouer la construction du workflow
    // ("object is not a function"). On dérive donc les libellés via `transform`.
    const noms = transform({ input }, (d) => ({
      salesChannel: `Boutique ${d.input.name}`,
      stockLocation: `Étal ${d.input.name}`,
      apiKey: `Vitrine ${d.input.name}`,
    }))

    const salesChannels = createSalesChannelsWorkflow.runAsStep({
      input: { salesChannelsData: [{ name: noms.salesChannel }] },
    })

    const stockLocations = createStockLocationsWorkflow.runAsStep({
      input: { locations: [{ name: noms.stockLocation }] },
    })

    const apiKeys = createApiKeysWorkflow.runAsStep({
      input: {
        api_keys: [
          { title: noms.apiKey, type: "publishable", created_by: "system" },
        ],
      },
    })

    const ids = transform(
      { marchand, salesChannels, stockLocations, apiKeys },
      (d) => ({
        merchant_id: d.marchand.id,
        sales_channel_id: d.salesChannels[0].id,
        stock_location_id: d.stockLocations[0].id,
        api_key_id: d.apiKeys[0].id,
        publishable_key: d.apiKeys[0].token,
      })
    )

    linkSalesChannelsToApiKeyWorkflow.runAsStep({
      input: { id: ids.api_key_id, add: [ids.sales_channel_id] },
    })

    linkSalesChannelsToStockLocationWorkflow.runAsStep({
      input: { id: ids.stock_location_id, add: [ids.sales_channel_id] },
    })

    createRemoteLinkStep([
      {
        [MERCHANT_MODULE]: { merchant_id: ids.merchant_id },
        [Modules.SALES_CHANNEL]: { sales_channel_id: ids.sales_channel_id },
      },
      {
        [MERCHANT_MODULE]: { merchant_id: ids.merchant_id },
        [Modules.STOCK_LOCATION]: { stock_location_id: ids.stock_location_id },
      },
      {
        [MERCHANT_MODULE]: { merchant_id: ids.merchant_id },
        [Modules.API_KEY]: { api_key_id: ids.api_key_id },
      },
    ])

    return new WorkflowResponse(ids)
  }
)

export default createMerchantWorkflow
