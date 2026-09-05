import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { catalogueDuMarchand, etiquetteJournal, marchandActifOuRefus } from "../../scope"
import { VISUAL_CATALOG_MODULE } from "../../../../../modules/visual-catalog"
import VisualCatalogModuleService from "../../../../../modules/visual-catalog/service"

const MESSAGE_ECHEC_GENERIQUE =
  "Le retrait de la vitrine a échoué. Réessayez plus tard."

/**
 * Retire un catalogue de la vitrine : il repasse en `draft`, et
 * `/c/<handle>` cesse de le servir (la vitrine filtre sur
 * `status: "published"`).
 *
 * AUCUN produit n'est supprimé, aucun stock n'est touché, aucun lien n'est
 * défait. Ce n'est pas une commodité : le handle d'un produit publié est
 * `<handle-boutique>-<libellé>-<8 derniers du zone_id>` (voir
 * workflows/appariement-produits.ts) et l'index `IDX_product_handle_unique`
 * est GLOBALEMENT unique. Le `zone_id` est stable d'une publication à
 * l'autre : si dépublier supprimait les produits, republier se heurterait à
 * cet index sur les produits qu'il vient lui-même d'effacer — ou, pire,
 * créerait des doublons silencieux si la suppression n'était que partielle.
 * Le stock et l'historique de la commerçante sont préservés par la même
 * décision.
 */
export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  // En TÊTE, avant toute lecture : un marchand suspendu ne retire plus rien
  // de la vitrine (c'est la suspension qui l'y a déjà retiré), et un
  // actor_id orphelin n'agit pas au nom d'un marchand disparu. L'identité
  // vient de la session, jamais du corps ni de l'URL.
  const controle = await marchandActifOuRefus(
    req.scope,
    req.auth_context.actor_id,
    etiquetteJournal(req, `POST /merchant/catalogues/${req.params.id}/unpublish`)
  )
  if (!controle.autorise) {
    return res.status(controle.statut).json({ message: controle.message })
  }

  const catalogue = await catalogueDuMarchand(
    req.scope,
    controle.marchand.id,
    req.params.id
  )
  if (!catalogue) {
    // 404 et non 403 : un 403 confirmerait à l'appelant l'existence du
    // catalogue d'autrui — même raisonnement que sur les autres routes.
    return res.status(404).json({ message: "Catalogue introuvable" })
  }
  if (catalogue.status !== "published") {
    // Un 200 ici laisserait croire à une action qui n'a pas eu lieu : il
    // n'y a rien à retirer d'une vitrine qui ne sert déjà plus ce
    // catalogue.
    return res.status(409).json({ message: "Ce catalogue n'est pas en ligne" })
  }

  // UNE seule écriture, donc rien à compenser : `updateVisualCatalogues`
  // ouvre sa propre transaction (`@InjectTransactionManager`, voir
  // node_modules/@medusajs/utils/dist/modules-sdk/decorators/inject-transaction-manager.js)
  // et il n'y a pas de seconde écriture qu'un échec laisserait à moitié
  // faite.
  const service = req.scope.resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
  try {
    await service.updateVisualCatalogues({ id: catalogue.id, status: "draft" })
  } catch (e: any) {
    // Une panne de base est un 5xx, jamais un 4xx qui accuserait la
    // commerçante. Le détail technique reste au journal serveur.
    logger.error(
      `POST /merchant/catalogues/${catalogue.id}/unpublish : échec du retrait — ${e?.message}`
    )
    return res.status(500).json({ message: MESSAGE_ECHEC_GENERIQUE })
  }

  res.json({ ok: true })
}
