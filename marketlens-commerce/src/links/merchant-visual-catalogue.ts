import { defineLink } from "@medusajs/framework/utils"
import MerchantModule from "../modules/merchant"
import VisualCatalogModule from "../modules/visual-catalog"

export default defineLink(
  MerchantModule.linkable.merchant,
  { linkable: VisualCatalogModule.linkable.visualCatalogue, isList: true }
)
