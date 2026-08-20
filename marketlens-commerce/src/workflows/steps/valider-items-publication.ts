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
export const validerItemsPublicationStep = createStep(
  "valider-items-publication",
  async (input: ValiderItemsPublicationInput) => {
    const idsZones = new Set(input.zones.map((z) => z.id))

    for (const item of input.items) {
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
      if (!idsZones.has(item.zone_id)) {
        throw new ErreurValidationPublication(
          `L'article « ${item.label} » référence une zone inconnue de ce catalogue.`
        )
      }
      const prix = Number(item.price)
      if (!Number.isFinite(prix) || prix <= 0) {
        throw new ErreurValidationPublication(
          `Le prix de « ${item.label} » doit être un nombre positif (reçu : « ${item.price} »).`
        )
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 0) {
        throw new ErreurValidationPublication(
          `La quantité de « ${item.label} » doit être un entier positif ou nul.`
        )
      }
    }

    return new StepResponse(true)
  }
)
