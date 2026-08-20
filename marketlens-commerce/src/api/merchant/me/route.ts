import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { etiquetteJournal, marchandActifOuRefus } from "../catalogues/scope"

/**
 * Cette route ne décide plus elle-même si un marchand a le droit d'être
 * servi : elle délègue à `marchandActifOuRefus` (src/api/merchant/catalogues/scope.ts),
 * qui porte les trois refus (401 identité non rattachée, 401 rattachement
 * orphelin, 403 statut non actif) pour TOUTES les routes marchand. Il n'y a
 * qu'un seul point de décision : deux copies de cette logique divergeraient,
 * et c'est exactement ce qui s'était produit — seule cette route lisait
 * `status`, si bien qu'une suspension n'avait aucun effet ailleurs.
 */
export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const controle = await marchandActifOuRefus(
    req.scope,
    req.auth_context.actor_id,
    etiquetteJournal(req, "GET /merchant/me")
  )
  if (!controle.autorise) {
    return res.status(controle.statut).json({ message: controle.message })
  }

  // Réponse façonnée à la main sur les sept champs du contrat : le modèle
  // DML expose aussi created_at/updated_at/deleted_at, que la route ne doit
  // jamais laisser fuir (deleted_at révélerait la suppression logique).
  const { id, name, handle, phone, whatsapp_phone, currency_code, status } =
    controle.marchand

  res.json({
    merchant: { id, name, handle, phone, whatsapp_phone, currency_code, status },
  })
}
