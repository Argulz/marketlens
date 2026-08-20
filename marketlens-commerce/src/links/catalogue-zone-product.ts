import { defineLink } from "@medusajs/framework/utils"
import ProductModule from "@medusajs/medusa/product"
import VisualCatalogModule from "../modules/visual-catalog"

export default defineLink(
  VisualCatalogModule.linkable.catalogueZone,
  ProductModule.linkable.product
)
