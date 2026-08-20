import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import createMerchantWorkflow from "../../src/workflows/create-merchant"
import { MERCHANT_MODULE } from "../../src/modules/merchant"
import { LONGUEUR_MAX_HANDLE } from "../../src/modules/merchant/handle"

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

      it("un handle déjà pris est rejeté proprement", async () => {
        // Ce test vérifie uniquement le rejet et l'absence de doublon de
        // marchand. Il ne prouve rien sur les compensations : la collision de
        // handle échoue dans la toute première étape (`createMerchantRecordStep`),
        // avant que le canal de vente, l'emplacement de stock ou la clé API
        // n'aient été créés — il n'y a donc rien à annuler pour ces
        // ressources-là. Le test de compensation réel est plus bas.
        const container = getContainer()

        await createMerchantWorkflow(container).run({
          input: { name: "Premier", handle: "collision", phone: "22990000010" },
        })

        // Note : on n'utilise pas `expect(...).rejects.toThrow()`. Dans cette
        // version du SDK, l'orchestrateur de workflow (`TransactionOrchestrator`)
        // capture l'erreur levée par une étape et rejette la promesse de `.run()`
        // avec une copie en objet simple (`{message, name, stack}`), pas avec
        // l'instance d'`Error`/`MedusaError` d'origine — vérifié directement
        // (`e instanceof Error` → false, `e.constructor.name` → "Object"). Le
        // matcher `toThrow()` exige une instance d'`Error` et ne reconnaît donc
        // jamais ce rejet. Les appels directs à un service de module (comme dans
        // les tests de la tâche 1) rejettent, eux, de vraies `Error` et restent
        // compatibles avec `toThrow()`. Le `try/catch` ci-dessous est la façon
        // fiable de vérifier un rejet de `.run()` ici.
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
      })

      it("annule le marchand, le canal de vente et l'emplacement de stock si la création de la clé API échoue", async () => {
        // Contrairement au test de collision de handle ci-dessus, cet échec est
        // déclenché APRÈS que le canal de vente et l'emplacement de stock ont
        // réellement été créés (le workflow est strictement séquentiel : ces
        // deux étapes s'exécutent avant celle de la clé API). Si les
        // compensations n'existaient pas, ces ressources et le marchand
        // resteraient orphelins en base.
        const container = getContainer()

        const salesChannelService = container.resolve(Modules.SALES_CHANNEL)
        const stockLocationService = container.resolve(Modules.STOCK_LOCATION)
        const apiKeyService: any = container.resolve(Modules.API_KEY)

        const salesChannelsAvant = await salesChannelService.listSalesChannels({})
        const stockLocationsAvant = await stockLocationService.listStockLocations({})

        const spy = jest
          .spyOn(apiKeyService, "createApiKeys")
          .mockRejectedValueOnce(new Error("échec simulé de création de clé API"))

        let aEchoue = false
        try {
          await createMerchantWorkflow(container).run({
            input: { name: "Échec Aval", handle: "echec-aval", phone: "22990000099" },
          })
        } catch (e) {
          aEchoue = true
        } finally {
          spy.mockRestore()
        }
        expect(aEchoue).toBe(true)

        const merchantService = container.resolve(MERCHANT_MODULE)
        const marchands = await merchantService.listMerchants({ handle: "echec-aval" })
        expect(marchands).toHaveLength(0)

        const salesChannelsApres = await salesChannelService.listSalesChannels({})
        const stockLocationsApres = await stockLocationService.listStockLocations({})

        expect(salesChannelsApres).toHaveLength(salesChannelsAvant.length)
        expect(stockLocationsApres).toHaveLength(stockLocationsAvant.length)
      })

      it("normalise le handle même appelé directement par le workflow", async () => {
        // La normalisation vivait dans la route d'inscription. Tout appel direct
        // — script d'opérateur, autre workflow — persistait un handle brut, et
        // deux casses différentes se disputeraient la même URL publique /c/<handle>.
        const { result } = await createMerchantWorkflow(getContainer()).run({
          input: { name: "Étal Direct", handle: "  ETAL-Direct  ", phone: "22990007001" },
        })

        const service = getContainer().resolve(MERCHANT_MODULE)
        const marchand = await service.retrieveMerchant(result.merchant_id)
        expect(marchand.handle).toBe("etal-direct")
      })

      it("refuse un handle trop long même appelé directement par le workflow", async () => {
        // La route d'inscription borne `handle` à LONGUEUR_MAX_HANDLE
        // caractères (réponse 400). La colonne `handle` en base n'a elle-même
        // aucune contrainte de longueur (model.text()) : rien ne rattrape un
        // appel direct au workflow qui contournerait la route. Ce handle est
        // par ailleurs valide (lettres minuscules uniquement) : seule la
        // longueur doit faire échouer la création.
        const container = getContainer()
        const handleTropLong = "a".repeat(LONGUEUR_MAX_HANDLE + 1)

        // Comme pour les autres rejets de `.run()` (voir note plus haut dans
        // ce fichier), l'orchestrateur ne rejette pas avec une instance
        // d'`Error` : `rejects.toThrow()` ne le reconnaîtrait pas. On utilise
        // donc un `try/catch` explicite.
        let aEchoue = false
        try {
          await createMerchantWorkflow(container).run({
            input: { name: "Handle Trop Long", handle: handleTropLong, phone: "22990007002" },
          })
        } catch (e) {
          aEchoue = true
        }
        expect(aEchoue).toBe(true)

        const merchantService = container.resolve(MERCHANT_MODULE)
        const marchands = await merchantService.listMerchants({ handle: handleTropLong })
        expect(marchands).toHaveLength(0)
      })
    })
  },
})
