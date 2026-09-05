import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  detailCatalogueDuMarchand,
  etiquetteJournal,
  marchandActifOuRefus,
  produitsAAnnoter,
} from "../../scope"
import {
  NOM_ERREUR_IMAGE_SOURCE_INDISPONIBLE,
  annoterCatalogueWorkflow,
} from "../../../../../workflows/annoter-catalogue"
import { VISUAL_CATALOG_MODULE } from "../../../../../modules/visual-catalog"
import VisualCatalogModuleService from "../../../../../modules/visual-catalog/service"

const MESSAGE_ECHEC_GENERIQUE =
  "La remise en ligne du catalogue a échoué. Réessayez plus tard."

const MESSAGE_PHOTO_PERDUE =
  "La photo d'origine de ce catalogue n'est plus disponible : " +
  "reprenez une photo de votre étal pour le remettre en ligne."

/**
 * Remet en ligne un catalogue dépublié : l'image annotée est RÉGÉNÉRÉE à
 * partir de la photo d'origine et des prix actuellement en base, puis le
 * catalogue repasse en `published`.
 *
 * AUCUN produit n'est créé : ils n'ont jamais été supprimés (voir
 * ../unpublish/route.ts), leurs handles sont toujours pris, et les recréer
 * échouerait sur `IDX_product_handle_unique`. Cette route ne fait donc que
 * redessiner et rouvrir.
 *
 * Aucun passage par la DÉTECTION non plus : les zones sont déjà connues et
 * validées par la commerçante. Seul le dessin change — c'est exactement ce
 * que `annoterCatalogueWorkflow` (tâche 6) sait faire, et cette route en est
 * le second consommateur après la correction des prix.
 */
export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  // En TÊTE, avant toute lecture : un marchand suspendu ne remet rien en
  // ligne — sa vitrine est justement ce que la suspension a coupé.
  // L'identité vient de la session, jamais du corps ni de l'URL.
  const controle = await marchandActifOuRefus(
    req.scope,
    req.auth_context.actor_id,
    etiquetteJournal(req, `POST /merchant/catalogues/${req.params.id}/republish`)
  )
  if (!controle.autorise) {
    return res.status(controle.statut).json({ message: controle.message })
  }

  const detail = await detailCatalogueDuMarchand(
    req.scope,
    controle.marchand.id,
    req.params.id
  )
  if (!detail) {
    // 404 et non 403 : un 403 confirmerait à l'appelant l'existence du
    // catalogue d'autrui.
    return res.status(404).json({ message: "Catalogue introuvable" })
  }
  if (detail.status === "published") {
    return res.status(409).json({ message: "Ce catalogue est déjà en ligne" })
  }

  // MÊME projection que la correction des prix : elle tranche deux
  // contraintes du lot (zones sans produit filtrées, libellé du produit
  // publié plutôt que `detected_label`), et une seconde copie ici les
  // re-trancherait en silence. Voir le commentaire de `produitsAAnnoter`
  // dans ../../scope.ts.
  const produits = produitsAAnnoter(detail)

  if (produits.length === 0) {
    // Chemin NOMINAL, et non garde défensive : une commerçante qui analyse
    // une photo sans rien tarifer obtient exactement cet état, et l'écran
    // lui montre ce bouton dès que le statut n'est pas `published`. Le
    // message doit donc dire quoi faire — parler de « remettre » en ligne un
    // catalogue qui n'y a jamais été serait faux, et la laisserait chercher
    // une vitrine qu'elle n'a jamais eue.
    return res.status(409).json({
      message:
        "Ce catalogue n'a aucun produit en vente : indiquez les prix de votre étal pour le mettre en ligne.",
    })
  }

  try {
    await annoterCatalogueWorkflow(req.scope).run({
      input: {
        catalogue_id: detail.id,
        source_image_id: detail.source_image_id,
        produits,
      },
    })
  } catch (e: any) {
    // Le rejet d'un `.run()` de workflow n'est pas l'instance d'origine :
    // l'orchestrateur la remplace par une copie en objet simple, dont seul
    // `.name` survit. `instanceof` est donc inutilisable ici.
    if (e?.name === NOM_ERREUR_IMAGE_SOURCE_INDISPONIBLE) {
      // Le catalogue RESTE en brouillon : remettre en ligne sans image à
      // jour servirait une vitrine qui ment sur les prix. Ce n'est ni une
      // faute de la commerçante ni une panne amont — c'est un état du
      // catalogue, d'où 409 et non 5xx, avec la seule issue réelle :
      // reprendre une photo.
      logger.warn(`Republication impossible pour ${detail.id} : ${e?.message}`)
      return res.status(409).json({ message: MESSAGE_PHOTO_PERDUE })
    }
    // Toute autre panne (service de vision, stockage, base) est un 5xx :
    // un 4xx accuserait la saisie de la commerçante d'une défaillance
    // amont. Le workflow a compensé son écriture d'URL annotée, et le
    // catalogue est resté en brouillon — rien n'a changé, le dire est donc
    // exact.
    logger.error(
      `POST /merchant/catalogues/${detail.id}/republish : régénération de l'image en échec — ${e?.message}`
    )
    return res.status(500).json({ message: MESSAGE_ECHEC_GENERIQUE })
  }

  // L'ordre compte, et il n'est pas symétrique de celui de la correction des
  // prix : l'image d'abord, la remise en ligne ensuite. Si cette seconde
  // écriture échoue, le catalogue reste en brouillon avec une image à jour —
  // une vitrine muette, jamais une vitrine qui mentirait sur les prix. C'est
  // le seul ordre dont l'état intermédiaire soit sans danger : les deux
  // écritures sont dans des transactions distinctes et rien ne les groupe.
  const service = req.scope.resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
  try {
    await service.updateVisualCatalogues({ id: detail.id, status: "published" })
  } catch (e: any) {
    logger.error(
      `POST /merchant/catalogues/${detail.id}/republish : échec de la remise en ligne — ${e?.message}`
    )
    return res.status(500).json({ message: MESSAGE_ECHEC_GENERIQUE })
  }

  res.json({ ok: true })
}
