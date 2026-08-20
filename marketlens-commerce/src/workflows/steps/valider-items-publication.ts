import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

export type ValiderItemsPublicationInput = {
  zones: { id: string }[]
  items: { zone_id: string; label: string; price: string; quantity: number }[]
}

/** Lecture pure, sans compensation : valide les articles avant toute
 *  écriture. Sans ce contrôle, un `zone_id` inconnu provoque un
 *  `TypeError` brut (`.find(...)!` dans le workflow), et un prix non
 *  numérique un `NaN` silencieux — tous deux APRÈS la création des
 *  produits, du stock et des liens, ce qu'aucune compensation ne répare
 *  proprement pour une erreur qui aurait dû être refusée à l'entrée. */
export const validerItemsPublicationStep = createStep(
  "valider-items-publication",
  async (input: ValiderItemsPublicationInput) => {
    const idsZones = new Set(input.zones.map((z) => z.id))

    for (const item of input.items) {
      if (!item.label || !item.label.trim()) {
        throw new Error("Chaque article doit avoir un libellé.")
      }
      if (!idsZones.has(item.zone_id)) {
        throw new Error(
          `L'article « ${item.label} » référence une zone inconnue de ce catalogue.`
        )
      }
      const prix = Number(item.price)
      if (!Number.isFinite(prix) || prix <= 0) {
        throw new Error(
          `Le prix de « ${item.label} » doit être un nombre positif (reçu : « ${item.price} »).`
        )
      }
      if (!Number.isInteger(item.quantity) || item.quantity < 0) {
        throw new Error(
          `La quantité de « ${item.label} » doit être un entier positif ou nul.`
        )
      }
    }

    return new StepResponse(true)
  }
)
