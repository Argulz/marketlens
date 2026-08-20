import path from "path"
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import publishCatalogueWorkflow from "../../../../../workflows/publish-catalogue"
import { assurerRegionXof } from "../../../../../workflows/ensure-region"
import { catalogueDuMarchand } from "../../scope"
import { VISUAL_CATALOG_MODULE } from "../../../../../modules/visual-catalog"
import VisualCatalogModuleService from "../../../../../modules/visual-catalog/service"

/**
 * Le fournisseur de fichiers local (celui utilisé par ce projet, faute de
 * configuration explicite d'un autre dans medusa-config.ts) sert ses
 * fichiers sous `<backend_url>/static/<clé>` — vérifié dans
 * node_modules/@medusajs/file-local/dist/services/local-file.js
 * (`getUploadFileUrl`). `FileModuleService.getAsBuffer` attend cette CLÉ,
 * pas l'URL complète (node_modules/@medusajs/file/dist/services/file-module-service.js) ;
 * on l'extrait donc du chemin de `source_image_url`, en ignorant l'hôte —
 * important en test, où `backend_url` par défaut ("http://localhost:9000")
 * ne correspond PAS au port aléatoire choisi par le serveur de test, ce qui
 * rendrait un second appel HTTP vers cette URL non fiable.
 *
 * Couplage assumé et limite connue : cette extraction suppose le
 * fournisseur de fichiers local. Elle casserait avec un fournisseur distant
 * (S3, etc.) dont les URLs ne suivent pas ce schéma — la clé de fichier
 * n'est actuellement pas persistée sur le catalogue, seule l'URL l'est.
 */
function clefFichierLocaleDepuisUrl(url: string): string {
  const chemin = new URL(url).pathname
  const prefixe = "/static/"
  if (!chemin.startsWith(prefixe)) {
    throw new Error(
      `Image source du catalogue illisible : l'URL enregistrée ne correspond pas au fournisseur de fichiers local attendu (« ${url} »).`
    )
  }
  return decodeURIComponent(chemin.slice(prefixe.length))
}

export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const merchantId = req.auth_context.actor_id
  const catalogue = await catalogueDuMarchand(req.scope, merchantId, req.params.id)

  if (!catalogue) {
    // 404 et non 403 : un 403 confirmerait à l'appelant l'existence du
    // catalogue d'autrui — même raisonnement que GET /merchant/me.
    return res.status(404).json({ message: "Catalogue introuvable" })
  }
  if (catalogue.status === "published") {
    return res.status(409).json({ message: "Ce catalogue est déjà publié" })
  }

  const items = (req.body as any)?.items
  if (!Array.isArray(items)) {
    return res.status(400).json({ message: "Le corps de la requête doit contenir un tableau items." })
  }

  // Idempotente, sans compensation : doit précéder toute création de prix,
  // pas vivre dans le workflow transactionnel.
  await assurerRegionXof(req.scope)

  // Les ressources d'infrastructure du marchand (canal de vente, emplacement
  // de stock) sont résolues ici, jamais acceptées du corps : un client
  // pourrait sinon publier ses propres produits dans le canal ou
  // l'emplacement d'un autre marchand, même en ne visant que son propre
  // catalogue.
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: infosMarchand } = await query.graph({
    entity: "merchant",
    fields: ["id", "sales_channel.id", "stock_location.id"],
    filters: { id: merchantId },
  })
  const salesChannelId = (infosMarchand[0] as any)?.sales_channel?.id
  const stockLocationId = (infosMarchand[0] as any)?.stock_location?.id
  if (!salesChannelId || !stockLocationId) {
    return res.status(500).json({
      message: "Ressources de provisionnement introuvables pour ce marchand.",
    })
  }

  // Les zones sont RELUES depuis la base, jamais acceptées du corps : un
  // appelant ne peut donc jamais faire créer un lien produit vers une zone
  // d'un autre catalogue.
  const catalogueService = req.scope.resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
  const zonesPersistees = await catalogueService.listCatalogueZones({
    catalogue_id: catalogue.id,
  })
  const zones = zonesPersistees.map((z) => ({
    id: z.id,
    x: z.x,
    y: z.y,
    width: z.width,
    height: z.height,
    category: z.detected_category,
  }))

  // L'image source vient du module File, via l'URL enregistrée sur le
  // catalogue — jamais du client (voir clefFichierLocaleDepuisUrl ci-dessus
  // pour la limite connue de cette résolution).
  let source_content: string
  let source_filename: string
  try {
    const fileService: any = req.scope.resolve(Modules.FILE)
    const fileKey = clefFichierLocaleDepuisUrl(catalogue.source_image_url)
    const tampon: Buffer = await fileService.getAsBuffer(fileKey)
    source_content = tampon.toString("binary")
    source_filename = path.basename(fileKey)
  } catch (e: any) {
    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
    logger.error(
      `POST /merchant/catalogues/${catalogue.id}/publish : image source illisible — ${e?.message}`
    )
    return res.status(500).json({
      message: "L'image source de ce catalogue est illisible ; publication impossible.",
    })
  }

  try {
    const { result } = await publishCatalogueWorkflow(req.scope).run({
      input: {
        catalogue_id: catalogue.id,
        merchant_id: merchantId,
        sales_channel_id: salesChannelId,
        stock_location_id: stockLocationId,
        source_content,
        source_filename,
        zones,
        items,
      },
    })
    res.json(result)
  } catch (e: any) {
    // Le rejet d'un `.run()` de workflow n'est pas une instance d'`Error`,
    // mais porte tout de même le message français de l'étape qui a refusé
    // (verifierCatalogueMarchandStep, validerItemsPublicationStep) — sûr à
    // renvoyer tel quel au client.
    res.status(400).json({ message: e?.message || "La publication du catalogue a échoué." })
  }
}
