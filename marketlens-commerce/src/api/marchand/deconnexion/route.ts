import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { ECRAN_CONNEXION } from "../garde"

/**
 * La session est détruite CÔTÉ SERVEUR, pas seulement effacée chez la
 * commerçante : un cookie simplement oublié par le navigateur reste
 * réutilisable par quiconque en a gardé la valeur. `clearCookie` ne vient
 * qu'ensuite, pour que le navigateur cesse d'envoyer un identifiant devenu
 * inutile.
 */
const terminer = async (req: MedusaRequest, res: MedusaResponse) => {
  const { sessionOptions, cookieOptions } = req.scope.resolve(
    ContainerRegistrationKeys.CONFIG_MODULE
  ).projectConfig
  const nomCookie = sessionOptions?.name ?? "connect.sid"

  try {
    await new Promise<void>((resoudre, rejeter) => {
      if (!req.session) return resoudre()
      req.session.destroy((e: unknown) => (e ? rejeter(e) : resoudre()))
    })
  } finally {
    // Dans le `finally` : même si la destruction échoue, on ne laisse pas la
    // commerçante repartir en croyant être sortie avec un cookie encore actif
    // dans son navigateur.
    res.clearCookie(nomCookie, cookieOptions)
  }

  res.redirect(302, ECRAN_CONNEXION)
}

export const POST = terminer
// Le lien « Se déconnecter » de l'en-tête est un GET : sans cette route, il
// tomberait sur un 404 et la commerçante resterait connectée en croyant
// être sortie.
export const GET = terminer
