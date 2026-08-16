import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import createMerchantWorkflow from "../../src/workflows/create-merchant"
import { MERCHANT_MODULE } from "../../src/modules/merchant"

jest.setTimeout(60 * 1000)

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    describe("createMerchantWorkflow", () => {
      it("provisionne un marchand complet", async () => {
        const { result } = await createMerchantWorkflow(getContainer()).run({
          input: {
            name: "Étal de Fatou",
            handle: "etal-de-fatou",
            phone: "22990000001",
          },
        })

        expect(result.merchant_id).toBeTruthy()
        expect(result.sales_channel_id).toBeTruthy()
        expect(result.stock_location_id).toBeTruthy()
        expect(result.publishable_key).toMatch(/^pk_/)
      })

      it("un handle déjà pris rejette sans laisser de ressource orpheline", async () => {
        const container = getContainer()

        await createMerchantWorkflow(container).run({
          input: { name: "Premier", handle: "collision", phone: "22990000010" },
        })

        const salesChannelService = container.resolve(Modules.SALES_CHANNEL)
        const stockLocationService = container.resolve(Modules.STOCK_LOCATION)

        const salesChannelsAvant = await salesChannelService.listSalesChannels({})
        const stockLocationsAvant = await stockLocationService.listStockLocations({})

        // Note : on n'utilise pas `expect(...).rejects.toThrow()` ici. Dans cet
        // environnement (NODE_OPTIONS=--experimental-vm-modules, requis par le
        // script de test), ce matcher échoue à détecter un rejet pourtant réel
        // et vérifié (confirmé par inspection manuelle de la même promesse via
        // `.then(onFulfilled, onRejected)` et par try/catch, qui la détectent de
        // façon fiable à 100% sur des dizaines d'exécutions). Le try/catch
        // ci-dessous est donc la façon fiable de vérifier le rejet ici.
        let aEchoue = false
        try {
          await createMerchantWorkflow(container).run({
            input: { name: "Second", handle: "collision", phone: "22990000011" },
          })
        } catch (e) {
          aEchoue = true
        }
        expect(aEchoue).toBe(true)

        const merchantService = container.resolve(MERCHANT_MODULE)
        const marchands = await merchantService.listMerchants({ handle: "collision" })
        expect(marchands).toHaveLength(1)

        const salesChannelsApres = await salesChannelService.listSalesChannels({})
        const stockLocationsApres = await stockLocationService.listStockLocations({})

        expect(salesChannelsApres).toHaveLength(salesChannelsAvant.length)
        expect(stockLocationsApres).toHaveLength(stockLocationsAvant.length)
      })
    })
  },
})
