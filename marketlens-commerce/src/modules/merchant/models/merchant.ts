import { model } from "@medusajs/framework/utils"

export const Merchant = model.define("merchant", {
  id: model.id().primaryKey(),
  name: model.text(),
  handle: model.text().unique(),
  phone: model.text(),
  whatsapp_phone: model.text().nullable(),
  currency_code: model.text().default("xof"),
  status: model.enum(["pending", "active", "suspended"]).default("pending"),
})
