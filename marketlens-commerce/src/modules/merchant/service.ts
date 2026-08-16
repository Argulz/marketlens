import { MedusaService } from "@medusajs/framework/utils"
import { Merchant } from "./models/merchant"

class MerchantModuleService extends MedusaService({ Merchant }) {}

export default MerchantModuleService
