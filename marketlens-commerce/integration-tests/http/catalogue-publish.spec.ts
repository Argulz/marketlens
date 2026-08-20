import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import publishCatalogueWorkflow from "../../src/workflows/publish-catalogue"
import analyzeCataloguePhotoWorkflow from "../../src/workflows/analyze-catalogue-photo"
import createMerchantWorkflow from "../../src/workflows/create-merchant"
import { VISUAL_CATALOG_MODULE } from "../../src/modules/visual-catalog"
import VisualCatalogModuleService from "../../src/modules/visual-catalog/service"
import { servirVisionFactice } from "./helpers/vision-stub"

jest.setTimeout(90 * 1000)

const CONTENU_PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("binary")

const ZONE_TOMATES = { label: "Tomates", x: 250, y: 400, width: 200, height: 150, category: "fruits_legumes" }
const ZONE_PAGNE = { label: "Pagne", x: 700, y: 500, width: 250, height: 300, category: "textile" }

async function compterProduits(container: any): Promise<number> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: "product", fields: ["id"] })
  return data.length
}

/** Traduit les zones d'un brouillon (issues d'`analyzeCataloguePhotoWorkflow`)
 *  vers le format attendu par `publishCatalogueWorkflow` : même contenu,
 *  champ renommé (`detected_category` → `category`). */
function zonesPourPublication(zones: any[]) {
  return zones.map((z) => ({
    id: z.id,
    x: z.x,
    y: z.y,
    width: z.width,
    height: z.height,
    category: z.detected_category,
  }))
}

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    describe("publishCatalogue", () => {
      it("crée de vrais produits avec variantes, prix XOF et stock", async () => {
        const vision = await servirVisionFactice({
          detect: { products: [ZONE_TOMATES, ZONE_PAGNE], count: 2 },
        })

        try {
          const { result: m } = await createMerchantWorkflow(getContainer()).run({
            input: { name: "Étal Publication", handle: "etal-publication", phone: "22990009001" },
          })

          const { result: brouillon } = await analyzeCataloguePhotoWorkflow(getContainer()).run({
            input: {
              merchant_id: m.merchant_id,
              filename: "etal.jpg",
              content: CONTENU_PHOTO,
              title: "Étal du jour",
            },
          })

          const zones = brouillon.zones

          const { result } = await publishCatalogueWorkflow(getContainer()).run({
            input: {
              catalogue_id: brouillon.catalogue_id,
              merchant_id: m.merchant_id,
              sales_channel_id: m.sales_channel_id,
              stock_location_id: m.stock_location_id,
              source_content: CONTENU_PHOTO,
              source_filename: "etal.jpg",
              zones: zonesPourPublication(zones),
              items: [
                {
                  zone_id: zones[0].id,
                  label: "Tomates fraîches",
                  price: "500",
                  quantity: 12,
                  colors: [],
                  sizes: [],
                },
                {
                  zone_id: zones[1].id,
                  label: "Pagne wax",
                  price: "8000",
                  quantity: 4,
                  colors: ["Rouge", "Bleu"],
                  sizes: ["M", "L"],
                },
              ],
            },
          })

          expect(result.product_ids).toHaveLength(2)
          expect(result.annotated_image_url).toBeTruthy()

          const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
          const { data } = await query.graph({
            entity: "product",
            fields: ["id", "title", "variants.id", "variants.title"],
            filters: { id: result.product_ids },
          })

          const pagne = data.find((p: any) => p.title === "Pagne wax")
          expect(pagne).toBeTruthy()
          // Deux couleurs × deux tailles = quatre variantes réelles, pas du texte libre.
          expect(pagne!.variants).toHaveLength(4)

          const tomates = data.find((p: any) => p.title === "Tomates fraîches")
          expect(tomates).toBeTruthy()
          expect(tomates!.variants).toHaveLength(1)

          const service = getContainer().resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
          const cat = await service.retrieveVisualCatalogue(brouillon.catalogue_id)
          expect(cat.status).toBe("published")
          expect(cat.annotated_image_url).toBeTruthy()

          // Les prix sont réellement persistés, en XOF.
          const { data: avecPrix } = await query.graph({
            entity: "product",
            fields: ["id", "variants.prices.amount", "variants.prices.currency_code"],
            filters: { id: result.product_ids },
          })
          for (const produit of avecPrix as any[]) {
            for (const variante of produit.variants) {
              expect(
                variante.prices.some((p: any) => p.currency_code === "xof" && p.amount > 0)
              ).toBe(true)
            }
          }

          // Un niveau de stock par variante, à l'emplacement du marchand — la
          // quantité saisie s'applique par variante, non répartie entre elles.
          const inventoryService = getContainer().resolve(Modules.INVENTORY)
          const niveaux = await inventoryService.listInventoryLevels({
            location_id: m.stock_location_id,
          })
          expect(niveaux).toHaveLength(5)
          expect(
            niveaux.map((n: any) => n.stocked_quantity).sort((a: number, b: number) => a - b)
          ).toEqual([4, 4, 4, 4, 12])
        } finally {
          await vision.fermer()
        }
      })

      it("ne laisse aucun produit orphelin si l'annotation échoue en aval", async () => {
        // L'orchestrateur est strictement séquentiel : forcer l'échec sur la
        // PREMIÈRE étape ne prouverait rien, aucune suivante ne s'exécutant.
        // On fait donc échouer l'annotation, qui vient APRÈS la création des
        // produits — seule façon d'exercer réellement leur compensation.
        const visionAnalyse = await servirVisionFactice({
          detect: { products: [ZONE_TOMATES], count: 1 },
        })

        let m: any
        let brouillon: any
        try {
          const res = await createMerchantWorkflow(getContainer()).run({
            input: { name: "Étal Publication Échec", handle: "etal-publication-echec", phone: "22990009002" },
          })
          m = res.result

          const res2 = await analyzeCataloguePhotoWorkflow(getContainer()).run({
            input: {
              merchant_id: m.merchant_id,
              filename: "etal.jpg",
              content: CONTENU_PHOTO,
              title: "Étal échec aval",
            },
          })
          brouillon = res2.result
        } finally {
          await visionAnalyse.fermer()
        }

        const avant = await compterProduits(getContainer())

        const entree = {
          catalogue_id: brouillon.catalogue_id,
          merchant_id: m.merchant_id,
          sales_channel_id: m.sales_channel_id,
          stock_location_id: m.stock_location_id,
          source_content: CONTENU_PHOTO,
          source_filename: "etal.jpg",
          zones: zonesPourPublication(brouillon.zones),
          items: [
            {
              zone_id: brouillon.zones[0].id,
              label: "Tomates fraîches",
              price: "500",
              quantity: 12,
              colors: [],
              sizes: [],
            },
          ],
        }

        const vision = await servirVisionFactice({
          detect: { products: [ZONE_TOMATES], count: 1 },
          statutAnnotate: 502,
        })

        // `finally` (et non un simple appel en fin de fonction) : si une
        // assertion échoue avant d'y arriver, le serveur factice doit tout
        // de même se fermer, sous peine de laisser un handle HTTP ouvert et
        // Jest de ne jamais sortir.
        try {
          let aEchoue = false
          try {
            await publishCatalogueWorkflow(getContainer()).run({ input: entree })
          } catch {
            aEchoue = true // les rejets de workflow ne sont pas des Error
          }
          expect(aEchoue).toBe(true)

          expect(await compterProduits(getContainer())).toBe(avant)

          const service = getContainer().resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
          const cat = await service.retrieveVisualCatalogue(brouillon.catalogue_id)
          expect(cat.status).toBe("draft") // la publication n'a pas eu lieu
        } finally {
          await vision.fermer()
        }
      })
    })
  },
})
