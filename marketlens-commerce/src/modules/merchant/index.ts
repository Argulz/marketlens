import { Module } from "@medusajs/framework/utils"
import MerchantModuleService from "./service"

export const MERCHANT_MODULE = "merchant"

export default Module(MERCHANT_MODULE, {
  service: MerchantModuleService,
})
