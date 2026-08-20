import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { VISUAL_CATALOG_MODULE } from "../../modules/visual-catalog"
import VisualCatalogModuleService from "../../modules/visual-catalog/service"
import { ZoneDetectee } from "../../lib/vision-client"

export type CreateCatalogueDraftInput = {
  title: string
  source_image_url: string
  zones: ZoneDetectee[]
}

export type CatalogueDraftZone = {
  id: string
  x: number
  y: number
  width: number
  height: number
  detected_label: string
  detected_category: string
}

export type CreateCatalogueDraftOutput = {
  catalogue_id: string
  handle: string
  zones: CatalogueDraftZone[]
}

type CompensationData = { catalogueId: string; zoneIds: string[] }

export const createCatalogueDraftStep = createStep(
  "create-catalogue-draft",
  async (input: CreateCatalogueDraftInput, { container }) => {
    const service = container.resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)

    // Le handle est engendré ICI et non dans un `transform` : un transform
    // peut être rejoué et produirait alors un handle différent du premier.
    // Le handle du catalogue est indépendant de celui du marchand — un
    // marchand publie plusieurs catalogues au fil des jours.
    const catalogue = await service.createVisualCatalogues({
      handle: `cat-${crypto.randomUUID().slice(0, 10)}`,
      title: input.title,
      source_image_url: input.source_image_url,
    })

    const zones: CatalogueDraftZone[] = []
    for (const zone of input.zones) {
      // `model.number()` produit une colonne SQL `integer`. `ZoneDetectee`
      // type ses coordonnées en `number`, ce qui autorise un flottant côté
      // TypeScript : le service de vision les produit déjà entières, mais
      // on n'en fait pas une dépendance — on arrondit explicitement ici,
      // juste avant la persistance.
      const persistee = await service.createCatalogueZones({
        catalogue_id: catalogue.id,
        x: Math.round(zone.x),
        y: Math.round(zone.y),
        width: Math.round(zone.width),
        height: Math.round(zone.height),
        detected_label: zone.label,
        detected_category: zone.category,
      })
      zones.push({
        id: persistee.id,
        x: persistee.x,
        y: persistee.y,
        width: persistee.width,
        height: persistee.height,
        detected_label: persistee.detected_label,
        detected_category: persistee.detected_category,
      })
    }

    const output: CreateCatalogueDraftOutput = {
      catalogue_id: catalogue.id,
      handle: catalogue.handle,
      zones,
    }

    const compensationData: CompensationData = {
      catalogueId: catalogue.id,
      zoneIds: zones.map((z) => z.id),
    }

    return new StepResponse(output, compensationData)
  },
  async (compensationData: CompensationData | undefined, { container }) => {
    if (!compensationData) return
    const service = container.resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
    // Les zones portent une clé étrangère vers le catalogue, posée sans
    // cascade de suppression en base (`on update cascade` seulement — voir
    // la migration du module visual-catalog). Il faut donc les effacer
    // avant le catalogue : dans l'autre ordre, Postgres refuserait la
    // suppression du parent tant que des zones le référencent encore.
    if (compensationData.zoneIds.length > 0) {
      await service.deleteCatalogueZones(compensationData.zoneIds)
    }
    await service.deleteVisualCatalogues([compensationData.catalogueId])
  }
)
