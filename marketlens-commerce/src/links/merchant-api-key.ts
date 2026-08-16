import { defineLink } from "@medusajs/framework/utils"
import MerchantModule from "../modules/merchant"
import ApiKeyModule from "@medusajs/medusa/api-key"

export default defineLink(
  MerchantModule.linkable.merchant,
  ApiKeyModule.linkable.apiKey
)
