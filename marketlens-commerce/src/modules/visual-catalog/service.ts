import { MedusaService } from "@medusajs/framework/utils"
import { CatalogueZone } from "./models/catalogue-zone"
import { VisualCatalogue } from "./models/visual-catalogue"

class VisualCatalogModuleService extends MedusaService({
  VisualCatalogue,
  CatalogueZone,
}) {}

export default VisualCatalogModuleService
