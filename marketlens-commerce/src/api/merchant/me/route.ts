import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MedusaError, ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MERCHANT_MODULE } from "../../../modules/merchant"
import MerchantModuleService from "../../../modules/merchant/service"

// Même message que l'absence d'actor_id ci-dessous : dans les deux cas, le
// jeton ne correspond plus à un marchand actif. actor_id ne vient jamais du
// client (il est posé par setAuthAppMetadataStep à l'inscription), donc un
// marchand introuvable ne peut résulter que d'un rattachement devenu
// invalide (marchand supprimé) — pas d'une ressource que le client aurait
// mal identifiée. Traiter ce cas comme un problème d'identité (401) plutôt
// que comme une ressource absente (404) garde un contrat d'erreur unique
// pour cette route et évite de calquer le message anglais généré par le
// dépôt Medusa (`Merchant with id: <id> was not found`).
//
// Le message est unique côté client, mais les deux branches se distinguent
// dans les journaux : un jeton sans actor_id est une configuration
// d'authentification incomplète, tandis qu'un actor_id qui ne résout plus
// est un marchand disparu sous une identité toujours vivante — un incident,
// pas une erreur d'appelant.
const MESSAGE_IDENTITE_NON_RATTACHEE = "Identité non rattachée à un marchand"

export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const merchantId = req.auth_context.actor_id

  if (!merchantId) {
    logger.warn(
      `GET /merchant/me : jeton authentifié sans actor_id (auth_identity_id=${req.auth_context.auth_identity_id}) — identité jamais rattachée à un marchand.`
    )
    return res.status(401).json({ message: MESSAGE_IDENTITE_NON_RATTACHEE })
  }

  const service = req.scope.resolve<MerchantModuleService>(MERCHANT_MODULE)

  let marchand
  try {
    marchand = await service.retrieveMerchant(merchantId)
  } catch (e) {
    if (e instanceof MedusaError && e.type === MedusaError.Types.NOT_FOUND) {
      logger.warn(
        `GET /merchant/me : actor_id=${merchantId} (auth_identity_id=${req.auth_context.auth_identity_id}) ne résout aucun marchand — rattachement orphelin.`
      )
      return res.status(401).json({ message: MESSAGE_IDENTITE_NON_RATTACHEE })
    }
    throw e
  }

  // `status` n'est pas décoratif : un marchand `pending` (jamais provisionné
  // par le workflow) ou `suspended` (coupé par l'opérateur) porte une
  // identité valide, mais ne doit pas être servi. Sans ce contrôle, la
  // suspension d'un marchand n'aurait aucun effet observable.
  if (marchand.status !== "active") {
    logger.warn(
      `GET /merchant/me : marchand ${merchantId} refusé, statut « ${marchand.status} ».`
    )
    return res.status(403).json({
      message: `Compte marchand inactif (statut : ${marchand.status})`,
    })
  }

  // Réponse façonnée à la main sur les sept champs du contrat : le modèle
  // DML expose aussi created_at/updated_at/deleted_at, que la route ne doit
  // jamais laisser fuir (deleted_at révélerait la suppression logique).
  const { id, name, handle, phone, whatsapp_phone, currency_code, status } = marchand

  res.json({
    merchant: { id, name, handle, phone, whatsapp_phone, currency_code, status },
  })
}
