import { Module } from "@medusajs/framework/utils"
import VisualCatalogModuleService from "./service"

export const VISUAL_CATALOG_MODULE = "visual_catalog"

export default Module(VISUAL_CATALOG_MODULE, {
  service: VisualCatalogModuleService,
})
