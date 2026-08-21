import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { detailCatalogueDuMarchand, etiquetteJournal, marchandActifOuRefus } from "../scope"

export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  // En TÊTE, avant toute lecture du catalogue : mêmes raisons que sur les
  // autres routes de ce module (voir GET /merchant/catalogues) — un marchand
  // suspendu ou un actor_id orphelin ne doit rien pouvoir lire, même son
  // propre historique.
  const controle = await marchandActifOuRefus(
    req.scope,
    req.auth_context.actor_id,
    etiquetteJournal(req, `GET /merchant/catalogues/${req.params.id}`)
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
    // catalogue d'autrui — même raisonnement que sur la route de publication.
    return res.status(404).json({ message: "Catalogue introuvable" })
  }
  res.json({ catalogue: detail })
}
