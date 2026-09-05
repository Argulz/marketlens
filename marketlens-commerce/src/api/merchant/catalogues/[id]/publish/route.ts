import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import publishCatalogueWorkflow from "../../../../../workflows/publish-catalogue"
import { assurerRegionXof } from "../../../../../workflows/ensure-region"
import { catalogueDuMarchand, etiquetteJournal, marchandActifOuRefus } from "../../scope"
import { VISUAL_CATALOG_MODULE } from "../../../../../modules/visual-catalog"
import VisualCatalogModuleService from "../../../../../modules/visual-catalog/service"
import { NOM_ERREUR_VALIDATION_PUBLICATION } from "../../../../../workflows/steps/erreur-validation-publication"
import { NOM_ERREUR_IMAGE_SOURCE_INDISPONIBLE } from "../../../../../workflows/annoter-catalogue"

const MESSAGE_ECHEC_GENERIQUE =
  "La publication du catalogue a échoué. Réessayez plus tard."

const MESSAGE_IMAGE_SOURCE_ILLISIBLE =
  "L'image source de ce catalogue est illisible ; publication impossible."

export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const merchantId = req.auth_context.actor_id

  // En TÊTE, avant même de résoudre le catalogue : un marchand suspendu ne
  // publie plus rien, et un actor_id orphelin ne publie pas au nom d'un
  // marchand disparu. Ce contrôle précède le 404 d'appartenance et le 409
  // « déjà publié » : le statut du compte est une question d'identité, pas
  // d'état du catalogue.
  const controle = await marchandActifOuRefus(
    req.scope,
    merchantId,
    etiquetteJournal(req, `POST /merchant/catalogues/${req.params.id}/publish`)
  )
  if (!controle.autorise) {
    return res.status(controle.statut).json({ message: controle.message })
  }

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

  // L'image source n'est plus lue ICI : le workflow d'annotation la relit
  // lui-même depuis le stockage, à partir de la clé de fichier persistée sur
  // le catalogue. La route ne transporte donc plus le contenu de l'image en
  // mémoire, et la déduction de cette clé depuis `source_image_url` — qui ne
  // marchait qu'avec le fournisseur local — a disparu avec elle.
  try {
    const { result } = await publishCatalogueWorkflow(req.scope).run({
      input: {
        catalogue_id: catalogue.id,
        merchant_id: merchantId,
        sales_channel_id: salesChannelId,
        stock_location_id: stockLocationId,
        source_image_id: catalogue.source_image_id,
        zones,
        items,
      },
    })
    res.json(result)
  } catch (e: any) {
    // Le rejet d'un `.run()` de workflow n'est pas une instance d'`Error`
    // (l'orchestrateur le remplace par une copie en objet simple — voir
    // erreur-validation-publication.ts pour la référence exacte), donc
    // `instanceof` est inutilisable ici : seul `e.name` — copié tel quel
    // par cette sérialisation — permet de reconnaître une erreur de SAISIE
    // levée par `validerItemsPublicationStep`.
    //
    // Tout le reste (panne du service de vision, de la base, d'un module
    // Medusa interne, ou même le refus de `verifierCatalogueMarchandStep`
    // qui ne devrait plus jamais se produire ici puisque l'appartenance est
    // déjà vérifiée plus haut) n'est PAS une erreur de saisie : la
    // compter comme un 400 la rendrait invisible à la supervision (une
    // panne serveur prise pour une faute du marchand) et renverrait au
    // passage un texte technique brut (contrainte Postgres, `TypeError`
    // V8...) à un marchand authentifié — la même fuite que le chemin de
    // lecture de fichier plus haut évite déjà en journalisant côté serveur
    // et en répondant un message stable.
    if (e?.name === NOM_ERREUR_VALIDATION_PUBLICATION) {
      return res.status(400).json({ message: e.message })
    }

    const journal = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

    // Photo d'origine introuvable : ni une faute de saisie (400), ni une
    // panne du service de vision. Le message reste celui que cette route
    // rendait déjà quand elle lisait le fichier elle-même — seul l'endroit
    // où l'échec est constaté a changé.
    if (e?.name === NOM_ERREUR_IMAGE_SOURCE_INDISPONIBLE) {
      journal.error(
        `POST /merchant/catalogues/${catalogue.id}/publish : image source illisible — ${e?.message}`
      )
      return res.status(500).json({ message: MESSAGE_IMAGE_SOURCE_ILLISIBLE })
    }

    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
    logger.error(
      `POST /merchant/catalogues/${catalogue.id}/publish : échec inattendu — ${e?.message}`
    )
    res.status(500).json({ message: MESSAGE_ECHEC_GENERIQUE })
  }
}
