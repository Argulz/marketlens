import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  updateInventoryLevelsWorkflow,
  upsertVariantPricesWorkflow,
} from "@medusajs/medusa/core-flows"
import {
  detailCatalogueDuMarchand,
  etiquetteJournal,
  marchandActifOuRefus,
  produitsAAnnoter,
} from "../../scope"
import {
  ErreurValidationPublication,
  NOM_ERREUR_VALIDATION_PUBLICATION,
} from "../../../../../workflows/steps/erreur-validation-publication"
import { validerArticlesTarifes } from "../../../../../workflows/steps/valider-items-publication"
import {
  NOM_ERREUR_IMAGE_SOURCE_INDISPONIBLE,
  annoterCatalogueWorkflow,
} from "../../../../../workflows/annoter-catalogue"

const MESSAGE_ECHEC_GENERIQUE =
  "La correction des prix a échoué. Réessayez plus tard."

/** L'image n'a pas suivi, mais les prix SONT à jour. Laisser croire que rien
 *  n'a changé serait le pire comportement possible : la commerçante
 *  ressaisirait ses prix, ou pire, croirait sa vitrine à jour. */
const AVERTISSEMENT_IMAGE_NON_REGENEREE =
  "Les prix sont à jour, mais l'image du catalogue n'a pas pu être regénérée : " +
  "la photo d'origine n'est plus disponible."

type ArticleCorrige = { zone_id: string; price: unknown; quantity: unknown }

/**
 * Corrige les prix et les quantités des produits déjà publiés d'un
 * catalogue, puis régénère son image annotée.
 *
 * L'ORDRE compte : le prix est la vérité, l'image n'en est qu'une
 * représentation. Les écritures commerciales viennent donc en premier, et un
 * échec d'annotation ne les annule pas — il ressort en `avertissement` sur
 * une réponse 200, jamais en 4xx et jamais en silence.
 */
export const PATCH = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  // En TÊTE, avant toute lecture : un marchand suspendu ne corrige plus
  // rien, et un actor_id orphelin ne corrige pas au nom d'un marchand
  // disparu. L'identité vient de la session, jamais du corps ni de l'URL.
  const controle = await marchandActifOuRefus(
    req.scope,
    req.auth_context.actor_id,
    etiquetteJournal(req, `PATCH /merchant/catalogues/${req.params.id}/items`)
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
    // catalogue d'autrui — même raisonnement que sur les autres routes.
    return res.status(404).json({ message: "Catalogue introuvable" })
  }
  if (detail.status !== "published") {
    // Un brouillon n'a aucun produit : il n'y a pas de prix à corriger, il y
    // a une publication à faire. Le dire plutôt que d'échouer plus loin sur
    // une zone sans produit.
    return res.status(409).json({
      message: "Ce catalogue n'est pas encore publié : il n'a pas de prix à corriger.",
    })
  }

  const items = (req.body as any)?.items
  if (!Array.isArray(items)) {
    return res
      .status(400)
      .json({ message: "Le corps de la requête doit contenir un tableau items." })
  }

  const articles = items as ArticleCorrige[]
  const zonesParId = new Map(detail.zones.map((z) => [z.id, z]))

  try {
    if (articles.length === 0) {
      throw new ErreurValidationPublication(
        "Indiquez au moins un article à corriger."
      )
    }

    // EXACTEMENT les règles de la publication (prix positif, quantité
    // entière positive ou nulle, zone connue et unique), par appel à la
    // fonction que `validerItemsPublicationStep` utilise lui-même — pas une
    // seconde copie qui divergerait.
    validerArticlesTarifes(detail.zones, articles, {
      libelleDe: (article) => zonesParId.get(article.zone_id)?.product?.title ?? "",
      verifierEnPlus: (article) => {
        const zone = zonesParId.get(article.zone_id)
        // Une zone connue peut ne porter AUCUN produit : la commerçante ne
        // l'a pas mise en vente à la publication (contrainte : une zone peut
        // ne porter aucun produit). Il n'y a alors ni prix ni stock à
        // corriger, et le lui dire vaut mieux qu'un échec technique en aval.
        if (zone && !zone.product) {
          throw new ErreurValidationPublication(
            `La zone « ${zone.detected_label} » n'a pas été mise en vente : elle n'a pas de prix à corriger.`
          )
        }
      },
    })
  } catch (e: any) {
    if (e?.name === NOM_ERREUR_VALIDATION_PUBLICATION) {
      return res.status(400).json({ message: e.message })
    }
    throw e
  }

  // L'emplacement de stock est RÉSOLU depuis le marchand de la session,
  // jamais accepté du corps : un client pourrait sinon poser du stock dans
  // l'emplacement d'une autre commerçante.
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: infosMarchand } = await query.graph({
    entity: "merchant",
    fields: ["id", "stock_location.id"],
    filters: { id: controle.marchand.id },
  })
  const stockLocationId = (infosMarchand[0] as any)?.stock_location?.id
  if (!stockLocationId) {
    logger.error(
      `PATCH /merchant/catalogues/${detail.id}/items : emplacement de stock introuvable pour le marchand ${controle.marchand.id}.`
    )
    return res.status(500).json({ message: MESSAGE_ECHEC_GENERIQUE })
  }

  // Les articles d'inventaire ne sont pas portés par `detailCatalogueDuMarchand`
  // (qui sert le détail affiché) : on les requête ici, pour les seules
  // variantes concernées.
  const produitsConcernes = articles.map((a) => zonesParId.get(a.zone_id)!.product!)
  const { data: avecInventaire } = await query.graph({
    entity: "product",
    fields: ["id", "variants.id", "variants.inventory_items.inventory_item_id"],
    filters: { id: produitsConcernes.map((p) => p.id) },
  })
  const inventaireParVariante = new Map<string, string[]>()
  for (const produit of avecInventaire as any[]) {
    for (const variante of produit.variants ?? []) {
      inventaireParVariante.set(
        variante.id,
        (variante.inventory_items ?? [])
          .filter((a: any) => !!a)
          .map((a: any) => a.inventory_item_id)
      )
    }
  }

  // Le prix saisi vaut pour TOUTES les déclinaisons du produit, comme à la
  // publication ; la quantité aussi (décision D5 : quantité PAR
  // déclinaison, pas répartie entre elles).
  const variantPrices: {
    variant_id: string
    product_id: string
    prices: { amount: number; currency_code: string }[]
  }[] = []
  const niveaux: {
    inventory_item_id: string
    location_id: string
    stocked_quantity: number
  }[] = []

  for (const article of articles) {
    const produit = zonesParId.get(article.zone_id)!.product!
    const montant = Number(article.price)
    const quantite = Number(article.quantity)
    for (const variante of produit.variants) {
      variantPrices.push({
        variant_id: variante.id,
        product_id: produit.id,
        prices: [{ amount: montant, currency_code: "xof" }],
      })
      for (const inventoryItemId of inventaireParVariante.get(variante.id) ?? []) {
        niveaux.push({
          inventory_item_id: inventoryItemId,
          location_id: stockLocationId,
          stocked_quantity: quantite,
        })
      }
    }
  }

  try {
    await upsertVariantPricesWorkflow(req.scope).run({
      input: {
        variantPrices,
        // Les variantes sont TOUTES préexistantes : les déclarer ici est ce
        // qui envoie `upsertVariantPricesWorkflow` sur son chemin de mise à
        // jour (remplacement des prix de l'ensemble de prix déjà lié) plutôt
        // que sur son chemin de création, qui poserait un second ensemble de
        // prix à côté du premier.
        previousVariantIds: variantPrices.map((v) => v.variant_id),
      },
    })

    if (niveaux.length > 0) {
      await updateInventoryLevelsWorkflow(req.scope).run({ input: { updates: niveaux } })
    }
  } catch (e: any) {
    logger.error(
      `PATCH /merchant/catalogues/${detail.id}/items : échec de la mise à jour des prix ou du stock — ${e?.message}`
    )
    return res.status(500).json({ message: MESSAGE_ECHEC_GENERIQUE })
  }

  // Relecture APRÈS écriture : l'image doit porter les prix réellement en
  // base, y compris ceux des zones que cette requête n'a pas touchées.
  // Reconstruire l'image à partir du corps de la requête la ferait diverger
  // de la vérité dès qu'un article serait absent de la correction.
  const detailAJour = await detailCatalogueDuMarchand(
    req.scope,
    controle.marchand.id,
    detail.id
  )
  if (!detailAJour) {
    logger.error(
      `PATCH /merchant/catalogues/${detail.id}/items : catalogue introuvable après mise à jour.`
    )
    return res.status(500).json({ message: MESSAGE_ECHEC_GENERIQUE })
  }

  try {
    await annoterCatalogueWorkflow(req.scope).run({
      input: {
        catalogue_id: detailAJour.id,
        source_image_id: detailAJour.source_image_id,
        produits: produitsAAnnoter(detailAJour),
      },
    })
  } catch (e: any) {
    // Le rejet d'un `.run()` de workflow n'est pas l'instance d'origine :
    // seul `.name` survit à la sérialisation de l'orchestrateur.
    if (e?.name === NOM_ERREUR_IMAGE_SOURCE_INDISPONIBLE) {
      logger.warn(
        `Régénération impossible pour ${detailAJour.id} : ${e?.message}`
      )
      return res.json({ ok: true, avertissement: AVERTISSEMENT_IMAGE_NON_REGENEREE })
    }

    // Toute autre panne (service de vision, stockage, base) laisse elle
    // aussi les prix à jour : refuser en 4xx accuserait la saisie de la
    // commerçante, et taire l'échec lui ferait croire sa vitrine à jour.
    logger.error(
      `PATCH /merchant/catalogues/${detailAJour.id}/items : régénération de l'image en échec — ${e?.message}`
    )
    return res.json({
      ok: true,
      avertissement:
        "Les prix sont à jour, mais l'image du catalogue n'a pas pu être regénérée. Réessayez dans quelques minutes.",
    })
  }

  res.json({ ok: true })
}
