import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { VISUAL_CATALOG_MODULE } from "../../src/modules/visual-catalog"
import VisualCatalogModuleService from "../../src/modules/visual-catalog/service"
import { VisualCatalogue } from "../../src/modules/visual-catalog/models/visual-catalogue"
import { CatalogueZone } from "../../src/modules/visual-catalog/models/catalogue-zone"

moduleIntegrationTestRunner<VisualCatalogModuleService>({
  moduleName: VISUAL_CATALOG_MODULE,
  resolve: "./src/modules/visual-catalog",
  moduleModels: [VisualCatalogue, CatalogueZone],
  testSuite: ({ service }) => {
    describe("VisualCatalogModuleService", () => {
      it("crée un catalogue en brouillon par défaut", async () => {
        const cat = await service.createVisualCatalogues({
          handle: "etal-du-matin",
          title: "Étal du matin",
          source_image_url: "http://localhost:9000/static/etal.jpg",
        })
        expect(cat.status).toBe("draft")
        expect(cat.annotated_image_url).toBeNull()
      })

      it("refuse deux catalogues portant le même handle", async () => {
        await service.createVisualCatalogues({
          handle: "doublon-cat", title: "A",
          source_image_url: "http://x/a.jpg",
        })
        await expect(
          service.createVisualCatalogues({
            handle: "doublon-cat", title: "B",
            source_image_url: "http://x/b.jpg",
          })
        ).rejects.toThrow()
      })

      it("porte des zones dont la géométrie survit au stockage", async () => {
        const cat = await service.createVisualCatalogues({
          handle: "etal-zones", title: "Zones",
          source_image_url: "http://x/z.jpg",
        })
        const zone = await service.createCatalogueZones({
          catalogue_id: cat.id,
          x: 250, y: 400, width: 200, height: 150,
          detected_label: "Tomates",
          detected_category: "fruits_legumes",
        })
        const relue = await service.retrieveCatalogueZone(zone.id)
        expect([relue.x, relue.y, relue.width, relue.height]).toEqual([250, 400, 200, 150])
      })
    })
  },
})
