import { defineLink } from "@medusajs/framework/utils"
import MerchantModule from "../modules/merchant"
import SalesChannelModule from "@medusajs/medusa/sales-channel"

export default defineLink(
  MerchantModule.linkable.merchant,
  SalesChannelModule.linkable.salesChannel
)
