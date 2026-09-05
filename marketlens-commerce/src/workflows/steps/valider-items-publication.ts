import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ErreurValidationPublication } from "./erreur-validation-publication"

export type ValiderItemsPublicationInput = {
  zones: { id: string }[]
  // `colors`/`sizes` sont typés `unknown` : ce sont les deux champs que la
  // route ne validait pas avant d'atteindre `variantesDe` dans
  // publish-catalogue.ts, qui fait `item.colors.length` sans garde — un
  // article dont le corps de la requête omet l'un des deux y provoquait un
  // `TypeError` anglais brut, renvoyé tel quel au marchand. `unknown` force
  // ce step à vérifier leur forme plutôt que de faire confiance au typage
  // `string[]` amont, qui ne protège en rien une entrée réseau non fiable.
  items: {
    zone_id: string
    label: string
    price: string
    quantity: number
    colors: unknown
    sizes: unknown
  }[]
}

/** Lecture pure, sans compensation : valide les articles avant toute
 *  écriture. Sans ce contrôle, un `zone_id` inconnu provoque un
 *  `TypeError` brut (`.find(...)!` dans le workflow), et un prix non
 *  numérique un `NaN` silencieux — tous deux APRÈS la création des
 *  produits, du stock et des liens, ce qu'aucune compensation ne répare
 *  proprement pour une erreur qui aurait dû être refusée à l'entrée.
 *
 *  Chaque refus lève `ErreurValidationPublication` (jamais `Error` nu) :
 *  c'est ce qui permet à la route de publication de distinguer une erreur
 *  de saisie (400) de toute autre panne (500, journalisée) — voir
 *  erreur-validation-publication.ts pour le détail du mécanisme. */
/** Un article tarifé, dans ce que la publication et la correction de prix
 *  ont en COMMUN : une zone, un prix, une quantité. `price` et `quantity`
 *  sont typés `unknown` — ils viennent d'un corps de requête, et le typage
 *  amont ne protège en rien une entrée réseau. */
export type ArticleTarife = {
  zone_id: string
  price: unknown
  quantity: unknown
}

export type OptionsValidationArticles<T extends ArticleTarife> = {
  /** Libellé affiché dans les messages de refus. Rend une chaîne vide quand
   *  aucun libellé n'est connu (correction de prix sur une zone inconnue) :
   *  les messages basculent alors sur une formulation sans nom, plutôt que
   *  d'afficher un libellé vide entre guillemets. */
  libelleDe: (item: T) => string
  /** Contrôles supplémentaires propres à un appelant, exécutés POUR CHAQUE
   *  article avant les règles communes — l'ordre des refus reste ainsi
   *  exactement celui d'origine côté publication. */
  verifierEnPlus?: (item: T) => void
}

/**
 * Règles de tarification communes à la publication et à la correction de
 * prix : une zone au plus une fois, connue du catalogue, un prix
 * strictement positif et une quantité entière positive ou nulle.
 *
 * Ces règles vivent ici, en une seule copie, précisément parce que deux
 * chemins les appliquent : une seconde copie côté route divergerait au
 * premier ajustement, et la correction de prix accepterait alors ce que la
 * publication refuse (ou l'inverse).
 *
 * Le cas « aucun article » n'en fait PAS partie : il n'a pas le même sens
 * des deux côtés (publier un catalogue vide est irrécupérable ; corriger
 * zéro prix n'est qu'un appel sans effet). Chaque appelant le traite avec
 * son propre message.
 */
export function validerArticlesTarifes<T extends ArticleTarife>(
  zones: { id: string }[],
  items: T[],
  options: OptionsValidationArticles<T>
): void {
  // Une zone porte AU PLUS un produit : `defineLink(catalogueZone,
  // product)` est un lien un-à-un. Deux articles sur la même zone
  // produisaient, selon les libellés, deux handles produit identiques
  // (violation de l'index unique global `IDX_product_handle_unique`) ou
  // deux liens sur la même zone (« Cannot create multiple links between
  // 'visual_catalog' and 'product' ») — dans les deux cas une violation en
  // anglais, levée APRÈS la création des produits, du stock et des liens.
  const idsUniques = new Set(items.map((i) => i.zone_id))
  if (idsUniques.size !== items.length) {
    throw new ErreurValidationPublication(
      "Deux articles ne peuvent pas désigner la même zone : une zone ne porte qu'un seul produit."
    )
  }

  const idsZones = new Set(zones.map((z) => z.id))

  for (const item of items) {
    options.verifierEnPlus?.(item)

    const libelle = options.libelleDe(item)

    if (!idsZones.has(item.zone_id)) {
      throw new ErreurValidationPublication(
        libelle
          ? `L'article « ${libelle} » référence une zone inconnue de ce catalogue.`
          : "Un des articles référence une zone inconnue de ce catalogue."
      )
    }
    const prix = Number(item.price)
    if (!Number.isFinite(prix) || prix <= 0) {
      throw new ErreurValidationPublication(
        libelle
          ? `Le prix de « ${libelle} » doit être un nombre positif (reçu : « ${item.price} »).`
          : `Le prix d'un article doit être un nombre positif (reçu : « ${item.price} »).`
      )
    }
    if (!Number.isInteger(item.quantity) || (item.quantity as number) < 0) {
      throw new ErreurValidationPublication(
        libelle
          ? `La quantité de « ${libelle} » doit être un entier positif ou nul.`
          : "La quantité d'un article doit être un entier positif ou nul."
      )
    }
  }
}

export const validerItemsPublicationStep = createStep(
  "valider-items-publication",
  async (input: ValiderItemsPublicationInput) => {
    // Un tableau vide n'est pas un catalogue publiable : la boucle
    // ci-dessous n'aurait rien à refuser, le workflow irait au bout et
    // basculerait le catalogue en `published` sans aucun produit, avec une
    // image « annotée » sans annotation. La route refusant en 409 toute
    // republication et aucune route de dépublication n'existant, l'état
    // serait définitif — irrécupérable par API.
    if (input.items.length === 0) {
      throw new ErreurValidationPublication(
        "Un catalogue doit contenir au moins un article pour être publié."
      )
    }

    // Les règles de tarification proprement dites vivent dans
    // `validerArticlesTarifes` : la correction de prix
    // (PATCH /merchant/catalogues/:id/items) applique EXACTEMENT les mêmes,
    // sans en recopier une ligne. Ne restent ici que les contrôles propres
    // à la publication — libellé, couleurs, tailles — passés en
    // `verifierEnPlus` pour que l'ordre des refus soit inchangé : par
    // article, ils précèdent le contrôle de la zone.
    validerArticlesTarifes(input.zones, input.items, {
      libelleDe: (item) => item.label,
      verifierEnPlus: (item) => {
        if (!item.label || !item.label.trim()) {
          throw new ErreurValidationPublication("Chaque article doit avoir un libellé.")
        }
        if (!Array.isArray(item.colors)) {
          throw new ErreurValidationPublication(
            `L'article « ${item.label} » doit indiquer ses couleurs sous forme de tableau (vide si aucune).`
          )
        }
        if (!Array.isArray(item.sizes)) {
          throw new ErreurValidationPublication(
            `L'article « ${item.label} » doit indiquer ses tailles sous forme de tableau (vide si aucune).`
          )
        }
      },
    })

    return new StepResponse(true)
  }
)
