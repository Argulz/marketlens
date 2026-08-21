import {
  authenticate,
  AuthenticatedMedusaRequest,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import {
  etiquetteJournal,
  marchandActifOuRefus,
  Marchand,
} from "../merchant/catalogues/scope"

// `Marchand` n'est PAS redéfini ici : une seconde définition divergerait de
// celle de scope.ts sans que rien ne le signale. Elle y est donc exportée.

/** Toutes les redirections de refus pointent vers cette adresse unique, sans
 *  motif : ne rien dire est la valeur par défaut, et le motif ne s'ajoute que
 *  là où il aide réellement la commerçante sans rien révéler. */
export const ECRAN_CONNEXION = "/marchand/connexion"

// L'intergiciel du framework, tel quel : il reste STRICT (pas de
// `allowUnauthenticated`). C'est délibéré — c'est lui qui garantit qu'une
// page ajoutée plus tard sous /marchand/* naît fermée même si son auteur
// oublie d'appeler `pageMarchandOuRedirection`. `allowUnregistered` laisse
// en revanche passer une identité authentifiée mais pas encore rattachée à
// un marchand : c'est la garde ci-dessous qui la refuse, en français et en
// redirigeant.
const intergicielFramework = authenticate("merchant", ["session", "bearer"], {
  allowUnregistered: true,
})

/**
 * Même contrôle d'authentification que les routes JSON, mais traduit pour un
 * navigateur. `authenticate` refuse en écrivant `res.status(401).json(...)` :
 * servir cet objet à une commerçante la laisserait devant `{"message":
 * "Unauthorized"}` au lieu de l'écran de connexion.
 *
 * On lui passe donc une réponse leurre, dont la seule fonction est d'absorber
 * ce refus sans qu'il n'atteigne le réseau. Le refus se lit alors à
 * l'absence d'appel à `next()`. Si une version future du framework refusait
 * autrement (`res.sendStatus`, par exemple), le leurre lèverait une
 * `TypeError` : la requête sortirait en 500, jamais en accès accordé — la
 * défaillance de ce mécanisme est fermée, pas ouverte.
 */
export const authentifierPageMarchand = async (
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) => {
  let autorise = false
  let erreurAmont: unknown

  const leurre = {
    status: () => ({ json: () => undefined }),
  } as unknown as MedusaResponse

  await intergicielFramework(req, leurre, ((erreur?: unknown) => {
    if (erreur) {
      erreurAmont = erreur
      return
    }
    autorise = true
  }) as MedusaNextFunction)

  if (erreurAmont) return next(erreurAmont)
  if (autorise) return next()

  res.redirect(302, ECRAN_CONNEXION)
}

/**
 * Garde d'accès des PAGES du back-office. Elle applique exactement le même
 * contrôle que les routes JSON — `marchandActifOuRefus`, point de décision
 * unique — mais traduit le refus en redirection : rendre un 401 JSON à un
 * navigateur laisserait la commerçante devant un objet d'erreur.
 *
 * Rend `null` quand l'accès est refusé, APRÈS avoir écrit la redirection :
 * l'appelant doit sortir immédiatement.
 */
export async function pageMarchandOuRedirection(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
  route: string
): Promise<Marchand | null> {
  // `auth_context` est déclaré non optionnel par le type, mais il est absent
  // en pratique dès qu'aucune identité n'a été reconnue : le lire sans
  // précaution ferait tomber la page en 500 au lieu de la rediriger.
  const contexte = (req as Partial<AuthenticatedMedusaRequest>).auth_context

  const controle = await marchandActifOuRefus(
    req.scope,
    contexte?.actor_id,
    contexte
      ? etiquetteJournal({ auth_context: contexte }, route)
      : `${route} (sans contexte d'authentification)`
  )

  if (!controle.autorise) {
    // Le motif est distingué pour que l'écran de connexion puisse dire
    // quelque chose d'utile — « votre compte n'est pas actif » est
    // actionnable, là où se reconnecter en boucle ne l'est pas. Il ne nomme
    // jamais la boutique ni le catalogue, et le 401 ne porte aucun motif :
    // distinguer « jamais connectée » de « identité orpheline » ne
    // renseignerait que quelqu'un qui n'a rien à y apprendre.
    const suffixe = controle.statut === 403 ? "?erreur=inactif" : ""
    res.redirect(302, `${ECRAN_CONNEXION}${suffixe}`)
    return null
  }

  return controle.marchand
}
