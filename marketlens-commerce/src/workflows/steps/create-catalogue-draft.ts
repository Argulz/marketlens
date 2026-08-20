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

    // Un seul appel groupé, pas une boucle : la méthode générée
    // `createCatalogueZones` accepte un tableau et l'écrit dans une unique
    // transaction (le service interne de module l'enveloppe via
    // `@InjectTransactionManager` dès qu'aucun `transactionManager` n'est
    // déjà présent dans le contexte — vérifié dans
    // node_modules/@medusajs/utils/dist/modules-sdk/decorators/inject-transaction-manager.js
    // et medusa-internal-service.js). Une boucle appelant le service une
    // fois par zone donnerait une transaction PAR zone (chaque appel de
    // méthode générée obtient son propre manager via `@InjectManager`
    // quand aucun contexte n'est transmis) : la zone N pourrait échouer
    // après que 1..N-1 aient déjà été committées, sans qu'aucune
    // compensation ne s'exécute jamais pour les nettoyer — le step
    // lui-même n'aurait pas retourné de `StepResponse`. Un appel unique
    // rend ce scénario impossible : soit toutes les zones sont écrites,
    // soit aucune ne l'est.
    let zonesPersistees: Awaited<ReturnType<VisualCatalogModuleService["createCatalogueZones"]>>
    try {
      zonesPersistees = await service.createCatalogueZones(
        input.zones.map((zone) => ({
          catalogue_id: catalogue.id,
          // `model.number()` produit une colonne SQL `integer`. `ZoneDetectee`
          // type ses coordonnées en `number`, ce qui autorise un flottant côté
          // TypeScript : le service de vision les produit déjà entières, mais
          // on n'en fait pas une dépendance — on arrondit explicitement ici,
          // juste avant la persistance.
          x: Math.round(zone.x),
          y: Math.round(zone.y),
          width: Math.round(zone.width),
          height: Math.round(zone.height),
          detected_label: zone.label,
          detected_category: zone.category,
        }))
      )
    } catch (e) {
      // La création du catalogue et celle des zones restent deux appels
      // distincts, chacun dans SA PROPRE transaction — les faire partager
      // une transaction exigerait de contourner le typage public de
      // `MedusaService` pour atteindre `baseRepository_` (propriété privée,
      // absente de `MedusaServiceReturnType`), au prix d'une dépendance non
      // documentée à un détail d'implémentation. Deux écritures séquentielles
      // restent une nette amélioration par rapport à N+1 ; ce filet couvre le
      // seul angle mort qu'il reste : si le catalogue a été créé mais que le
      // lot de zones échoue, le step lui-même n'aura jamais retourné de
      // `StepResponse` — sa propre compensation ne sera donc jamais invoquée
      // par l'orchestrateur — et le catalogue resterait sinon orphelin, sans
      // aucune zone. On l'efface nous-mêmes avant de repropager l'erreur.
      await service.deleteVisualCatalogues([catalogue.id])
      throw e
    }

    const zones: CatalogueDraftZone[] = zonesPersistees.map((persistee) => ({
      id: persistee.id,
      x: persistee.x,
      y: persistee.y,
      width: persistee.width,
      height: persistee.height,
      detected_label: persistee.detected_label,
      detected_category: persistee.detected_category,
    }))

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
