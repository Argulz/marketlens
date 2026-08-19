import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError } from "@medusajs/framework/utils"
import { MERCHANT_MODULE } from "../../../modules/merchant"

// Même message que l'absence d'actor_id ci-dessous : dans les deux cas, le
// jeton ne correspond plus à un marchand actif. actor_id ne vient jamais du
// client (il est posé par setAuthAppMetadataStep à l'inscription), donc un
// marchand introuvable ne peut résulter que d'un rattachement devenu
// invalide (marchand supprimé) — pas d'une ressource que le client aurait
// mal identifiée. Traiter ce cas comme un problème d'identité (401) plutôt
// que comme une ressource absente (404) garde un contrat d'erreur unique
// pour cette route et évite de calquer le message anglais généré par le
// dépôt Medusa (`Merchant with id: <id> was not found`).
const MESSAGE_IDENTITE_NON_RATTACHEE = "Identité non rattachée à un marchand"

export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const merchantId = req.auth_context.actor_id

  if (!merchantId) {
    return res.status(401).json({ message: MESSAGE_IDENTITE_NON_RATTACHEE })
  }

  const service: any = req.scope.resolve(MERCHANT_MODULE)

  let marchand
  try {
    marchand = await service.retrieveMerchant(merchantId)
  } catch (e) {
    if (e instanceof MedusaError && e.type === MedusaError.Types.NOT_FOUND) {
      return res.status(401).json({ message: MESSAGE_IDENTITE_NON_RATTACHEE })
    }
    throw e
  }

  // Réponse façonnée à la main sur les sept champs du contrat : le modèle
  // DML expose aussi created_at/updated_at/deleted_at, que la route ne doit
  // jamais laisser fuir (deleted_at révélerait la suppression logique).
  const { id, name, handle, phone, whatsapp_phone, currency_code, status } = marchand

  res.json({
    merchant: { id, name, handle, phone, whatsapp_phone, currency_code, status },
  })
}
