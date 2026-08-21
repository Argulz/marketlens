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

/**
 * LE contrat que consomment toutes les PAGES du back-office.
 *
 * `marchand` est **non nullable**, et c'est la seule chose que ce type a à
 * dire : `authentifierPageMarchand` s'exécute avant le routage sur chaque
 * requête `/marchand/*` et n'appelle `next()` **qu'après** l'avoir posé. Une
 * route qui reçoit la main a donc, par construction, un marchand résolu et
 * actif — il n'y a plus rien à vérifier, ni rien à oublier de vérifier.
 *
 * C'est ce qui remplace l'ancien `pageMarchandOuRedirection`, qui rendait
 * `Marchand | null` et confiait à chaque page le soin de sortir sur `null`.
 * Ce contrat-là ne tenait pas : le typage ne liait pas « rendre `null` » à
 * « avoir déjà écrit une réponse », rien n'obligeait l'appelant à sortir, et
 * l'oubli ne se manifestait pas par une erreur mais par une **requête qui
 * pend** — le pire mode d'échec possible, parce qu'il ne laisse aucune trace.
 *
 * Une page qui déclarerait `MedusaRequest` au lieu de ce type-ci n'aurait
 * simplement pas accès à `marchand` : elle ne peut plus s'ouvrir par
 * inadvertance, elle peut seulement se priver du marchand.
 */
export type RequetePageMarchand = AuthenticatedMedusaRequest & {
  marchand: Marchand
}

// L'intergiciel du framework, tel quel : il reste STRICT (pas de
// `allowUnauthenticated`). C'est délibéré — c'est lui qui garantit qu'une
// page ajoutée plus tard sous /marchand/* naît fermée même si son auteur
// n'y pense pas. `allowUnregistered` laisse en revanche passer une identité
// authentifiée mais pas encore rattachée à un marchand : c'est
// `marchandActifOuRefus`, ci-dessous, qui la refuse — en français et en
// redirigeant.
const intergicielFramework = authenticate("merchant", ["session", "bearer"], {
  allowUnregistered: true,
})

/**
 * Contrôle d'accès COMPLET des pages du back-office, exécuté avant le
 * routage sur chaque requête `/marchand/*` (voir `src/api/middlewares.ts`).
 * Il enchaîne les deux moitiés de la décision, qui étaient auparavant
 * séparées — l'intergiciel ici, `marchandActifOuRefus` dans chaque route :
 *
 *  1. le contrôle d'authentification du framework, traduit pour un
 *     navigateur (redirection, jamais un 401 JSON) ;
 *  2. `marchandActifOuRefus`, seul point de décision « ce jeton porte-t-il un
 *     marchand qui a le droit d'agir ? », jamais réécrit ici.
 *
 * Le marchand résolu est posé sur la requête (`req.marchand`, voir
 * `RequetePageMarchand`). Les routes ne relisent donc plus l'identité : la
 * double lecture — `authenticate` puis un second `marchandActifOuRefus` —
 * disparaît, et l'oubli d'appeler la garde devient impossible.
 *
 * --- Le leurre, et pourquoi il tient ---
 *
 * `authenticate` refuse en écrivant `res.status(401).json(...)` : servir cet
 * objet à une commerçante la laisserait devant `{"message":"Unauthorized"}`
 * au lieu de l'écran de connexion. On lui passe donc une réponse leurre dont
 * la seule fonction est d'absorber ce refus sans qu'il n'atteigne le réseau,
 * et on lit le verdict à l'appel — ou non — de `next()`.
 *
 * Ce montage repose sur TROIS faits, tous vérifiés, et non sur un seul :
 *
 *  a. le refus passe bien par `res.status(...).json(...)` — c'est ce que le
 *     leurre absorbe. Si une version future refusait autrement
 *     (`res.sendStatus`), le leurre lèverait une `TypeError` ;
 *  b. `authenticate` appelle `next()` de façon **synchrone par rapport à la
 *     promesse qu'on attend ici** : le verdict doit être écrit dans
 *     `autorise` avant que le `await` ne rende la main. S'il devenait
 *     asynchrone au-delà de cette promesse, on lirait `autorise === false` et
 *     on redirigerait vers la connexion — refus, jamais accès ;
 *  c. c'est `wrapHandler` de Medusa
 *     (node_modules/@medusajs/framework/dist/http/utils/wrap-handler.js), et
 *     **non Express**, qui enveloppe cet intergiciel et transforme un rejet
 *     de sa promesse en `next(err)`, donc en 500. Express 4 n'attend pas les
 *     intergiciels `async` : sans `wrapHandler`, un rejet ici ne produirait
 *     pas une erreur mais une requête **qui pend**. C'est la seule chose qui
 *     distingue « 500 » de « pendue », et elle vient du framework, pas de ce
 *     fichier.
 *
 * Autrement dit : la défaillance de ce mécanisme est fermée (redirection ou
 * 500), jamais ouverte.
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
  if (!autorise) return res.redirect(302, ECRAN_CONNEXION)

  // `auth_context` est déclaré non optionnel par le type, mais il est absent
  // en pratique dès qu'aucune identité n'a été reconnue : le lire sans
  // précaution ferait tomber la page en 500 au lieu de la rediriger.
  const contexte = (req as Partial<AuthenticatedMedusaRequest>).auth_context
  // `req.originalUrl` et non `req.path` : un intergiciel monté par
  // `app.use(matcher, ...)` voit une URL RÉÉCRITE, relative au point de
  // montage — `req.path` y vaut `/` pour une requête sur `/marchand`, ce qui
  // rend le journal muet sur la page réellement demandée. La chaîne de
  // requête est retirée : elle n'a rien à faire dans une étiquette de
  // journal, et pourrait y transporter n'importe quoi.
  const route = `${req.method} ${req.originalUrl.split("?")[0]}`

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
    // jamais la boutique ni le catalogue, et le refus d'identité ne porte
    // aucun motif : distinguer « jamais connectée » de « identité orpheline »
    // ne renseignerait que quelqu'un qui n'a rien à y apprendre.
    const suffixe = controle.statut === 403 ? "?erreur=inactif" : ""
    return res.redirect(302, `${ECRAN_CONNEXION}${suffixe}`)
  }

  ;(req as RequetePageMarchand).marchand = controle.marchand
  next()
}
