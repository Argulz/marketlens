import { defineLink } from "@medusajs/framework/utils"
import MerchantModule from "../modules/merchant"
import StockLocationModule from "@medusajs/medusa/stock-location"

export default defineLink(
  MerchantModule.linkable.merchant,
  StockLocationModule.linkable.stockLocation
)
