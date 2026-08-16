import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { MERCHANT_MODULE } from "../../src/modules/merchant"
import MerchantModuleService from "../../src/modules/merchant/service"
import { Merchant } from "../../src/modules/merchant/models/merchant"

moduleIntegrationTestRunner<MerchantModuleService>({
  moduleName: MERCHANT_MODULE,
  moduleModels: [Merchant],
  resolve: "./src/modules/merchant",
  testSuite: ({ service }) => {
    describe("MerchantModuleService", () => {
      it("crée un marchand avec les valeurs par défaut attendues", async () => {
        const marchand = await service.createMerchants({
          name: "Étal de Fatou",
          handle: "etal-de-fatou",
          phone: "22990000001",
        })

        expect(marchand.id).toBeTruthy()
        expect(marchand.currency_code).toBe("xof")
        expect(marchand.status).toBe("pending")
        expect(marchand.whatsapp_phone).toBeNull()
      })

      it("refuse deux marchands portant le même handle", async () => {
        await service.createMerchants({
          name: "Étal A", handle: "doublon", phone: "22990000002",
        })

        await expect(
          service.createMerchants({
            name: "Étal B", handle: "doublon", phone: "22990000003",
          })
        ).rejects.toThrow()
      })

      it("retrouve un marchand par son handle", async () => {
        await service.createMerchants({
          name: "Étal de Kofi", handle: "etal-de-kofi", phone: "22990000004",
        })

        const [trouve] = await service.listMerchants({ handle: "etal-de-kofi" })
        expect(trouve.name).toBe("Étal de Kofi")
      })
    })
  },
})
