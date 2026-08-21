import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { html } from "../../../lib/html"
import { page } from "../../../lib/pages/layout"
import { ECRAN_CONNEXION } from "../garde"

// Deux clés, et deux seulement : ce sont exactement les deux motifs qu'une
// redirection de ce dépôt sait émettre (`?erreur=inactif` depuis la garde,
// `?erreur=identifiants` depuis ce fichier). Une troisième entrée jamais
// émise ne serait pas une réserve pour plus tard, ce serait un message mort
// qu'on croirait servi.
const MESSAGES: Record<string, string> = {
  inactif: "Votre compte n'est pas actif. Contactez l'équipe MarketLens.",
  identifiants: "Adresse ou mot de passe incorrect.",
}

// Message unique pour TOUT échec de connexion imputable à la saisie, quelle
// qu'en soit la cause : adresse inconnue, mot de passe faux, ou identité qui
// existe mais n'est pas marchande. Distinguer ces cas transformerait cet
// écran en oracle d'existence de comptes.
const REFUS = `${ECRAN_CONNEXION}?erreur=identifiants`

/**
 * Les SEULES causes que le fournisseur `emailpass` compose lui-même à propos
 * de ce qui a été saisi. Relevées une à une dans sa méthode `authenticate`
 * (node_modules/@medusajs/auth-emailpass/dist/services/emailpass.js) :
 *
 *   - "Password should be a string" — champ absent ou non textuel ;
 *   - "Email should be a string"    — idem ;
 *   - "Invalid email or password"   — identité introuvable (`NOT_FOUND`),
 *                                     ou hachage scrypt qui ne vérifie pas.
 *
 * Tout le reste est un `error.message` rattrapé par un `catch` — chez le
 * fournisseur pour une erreur non-`NOT_FOUND`, et chez le module lui-même
 * (node_modules/@medusajs/auth/dist/services/auth-module.js : `catch (error)
 * { return { success: false, error: error.message } }`), qui avale ainsi
 * TOUTE exception. Une coupure Postgres pendant une connexion arrive donc
 * ici sous exactement la même forme qu'un mot de passe faux.
 *
 * Sans ce tri, une panne serveur était rendue à la commerçante comme
 * « Adresse ou mot de passe incorrect » : un 4xx qui accuse sa saisie, et un
 * incident invisible en exploitation. Ce tri n'est pas un oracle d'existence
 * de compte pour autant — « le service est indisponible » ne dit rien de
 * l'adresse tapée.
 */
const CAUSES_IDENTIFIANTS = new Set([
  "Password should be a string",
  "Email should be a string",
  "Invalid email or password",
])

/** Rendu à la commerçante pour TOUT incident serveur de cet écran, quel que
 *  soit le code HTTP : elle n'a rien à y corriger, et rien de technique n'a
 *  à lui parvenir. Le tri entre les incidents se fait dans le journal et
 *  dans le code de statut, qui ne sortent pas du serveur. */
const MESSAGE_INCIDENT =
  "La connexion est momentanément indisponible. Ce n'est pas votre saisie qui est en cause : réessayez dans quelques instants, ou contactez l'équipe MarketLens."

const servirIncident = (res: MedusaResponse, statut: number) => {
  const corps = html`
    <div class="err">${MESSAGE_INCIDENT}</div>
    <h1>Connexion indisponible</h1>
    <p class="sous">
      <a class="lien" href="${ECRAN_CONNEXION}">Revenir à l'écran de connexion</a>
    </p>`
  res.status(statut)
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.send(page({ titre: "Connexion indisponible", corps }))
}

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const cle = String(req.query.erreur ?? "")
  const message = MESSAGES[cle]

  const corps = html`
    ${message ? html`<div class="err">${message}</div>` : null}
    <h1>Se connecter</h1>
    <p class="sous">Votre boutique MarketLens.</p>
    <form class="carte" method="post" action="/marchand/connexion">
      <label for="email">Adresse e-mail</label>
      <input id="email" name="email" type="email" required autocomplete="username">
      <label for="motdepasse">Mot de passe</label>
      <input id="motdepasse" name="motdepasse" type="password" required
             autocomplete="current-password">
      <button type="submit">Entrer</button>
    </form>`

  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.send(page({ titre: "Connexion", corps }))
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const { email, motdepasse } = (req.body ?? {}) as Record<string, unknown>

  if (typeof email !== "string" || typeof motdepasse !== "string" || !email || !motdepasse) {
    return res.redirect(302, REFUS)
  }

  // On appelle le module d'authentification plutôt que de revérifier un mot
  // de passe à la main : le hachage scrypt et sa comparaison à temps constant
  // vivent là, et nulle part ailleurs.
  const service: any = req.scope.resolve(Modules.AUTH)
  const { success, error, authIdentity, mfaChallenge, location } =
    await service.authenticate("emailpass", {
      actor_type: "merchant",
      url: req.url,
      headers: req.headers,
      query: req.query,
      body: { email, password: motdepasse },
      protocol: req.protocol,
    })

  // Contrôle AVANT tout autre : un `success: true` ne signifie pas que
  // l'identité est prouvée.
  //
  //  - `mfaChallenge` : `applyMfaRequirement_` (auth-module.js) rend
  //    `{ success: true, mfaChallenge, authIdentity }` SANS que le défi ait
  //    été résolu ; la route du framework, elle, le voit et n'émet alors
  //    qu'un jeton SANS acteur (`mfa_required: true`). Un test naïf sur
  //    `success && authIdentity` poserait ici une session pleinement
  //    privilégiée en sautant le second facteur ;
  //  - `location` : le fournisseur demande une redirection vers un service
  //    externe. L'identité n'est pas encore prouvée du tout.
  //
  // Aucun des deux ne peut se produire aujourd'hui — aucun facteur MFA
  // n'existe et `medusa-config.ts` n'en déclare aucun. C'est précisément
  // pourquoi ce contrôle est écrit : le jour où quelqu'un active le MFA
  // marchand, `/auth/merchant/emailpass` l'appliquerait et cet écran-ci
  // l'aurait sauté, sans le moindre signal. C'est une incohérence de
  // configuration, pas une erreur d'utilisatrice : elle part en `error` et
  // en 500, jamais en « identifiants incorrects ».
  if (mfaChallenge || location) {
    logger.error(
      `POST /marchand/connexion : le module d'authentification exige une étape que cet écran n'implémente pas (${
        mfaChallenge ? "défi MFA non résolu" : "redirection vers un fournisseur externe"
      }) — connexion refusée. Incohérence de configuration à corriger.`
    )
    return servirIncident(res, 500)
  }

  if (!success || !authIdentity) {
    if (!CAUSES_IDENTIFIANTS.has(String(error))) {
      // Ni le module ni le fournisseur ne laissent remonter d'exception :
      // une panne amont arrive ici sous la même forme qu'un mot de passe
      // faux. La replier sur `?erreur=identifiants` accuserait la saisie de
      // la commerçante et rendrait l'incident invisible. On sort donc en
      // 503 — le service est indisponible, ce qui ne dit rien de l'adresse.
      logger.error(
        `POST /marchand/connexion : panne du module d'authentification (${
          error ?? "cause inconnue"
        }) — connexion impossible.`
      )
      return servirIncident(res, 503)
    }

    // Le détail technique va au journal ; la commerçante reçoit un message
    // unique, qui ne dit pas si c'est l'adresse ou le mot de passe qui cloche.
    logger.warn(`POST /marchand/connexion : identifiants refusés (${error}).`)
    return res.redirect(302, REFUS)
  }

  // LE contrôle de sécurité de cet écran. `actor_type: "merchant"` ci-dessus
  // ne filtre rien du tout : le fournisseur emailpass retrouve l'identité par
  // l'adresse e-mail seule et ne consulte jamais le type d'acteur
  // (node_modules/@medusajs/auth-emailpass/dist/services/emailpass.js). Une
  // identité de cliente ou d'administrateur portant la même adresse
  // s'authentifie donc « avec succès ». Le framework ne rattrape pas non
  // plus : quand il ne trouve pas `<acteur>_id`, il émet un contexte avec
  // `actor_id: ""` au lieu d'échouer
  // (node_modules/@medusajs/medusa/dist/api/auth/utils/generate-jwt-token.js:61-63).
  // C'est donc ici, et seulement ici, que « cette identité est-elle
  // marchande ? » se décide.
  const merchantId = authIdentity.app_metadata?.merchant_id
  if (typeof merchantId !== "string" || !merchantId) {
    // Journalisé comme un refus distinct — c'est un signal utile en
    // exploitation — mais rendu à l'identique côté commerçante : lui dire
    // « ce compte n'est pas marchand » confirmerait que l'adresse existe.
    logger.warn(
      `POST /marchand/connexion : identité ${authIdentity.id} authentifiée mais non rattachée à un marchand — refusée.`
    )
    return res.redirect(302, REFUS)
  }

  // Même trappe que `mfaChallenge`, pour la vérification d'adresse e-mail —
  // et elle se referme ici parce qu'elle ne se referme nulle part ailleurs.
  // Le framework la fait respecter dans `validateVerification`
  // (node_modules/@medusajs/medusa/dist/api/auth/utils/validate-verification.js),
  // appelé depuis `generateJwtTokenWithChecks` : donc uniquement sur la route
  // `/auth/<acteur>/<fournisseur>`, par laquelle cet écran ne passe pas.
  // Activer `authVerificationsPerActor.merchant` ferait donc respecter la
  // vérification côté API et l'ignorer intégralement côté back-office.
  //
  // On refuse SANS lire `verified_at`, à dessein : cet écran n'implémente
  // aucun parcours de vérification (ni renvoi de code, ni page de
  // confirmation). Réimplémenter ici les trois lectures internes du framework
  // pour laisser passer les identités déjà vérifiées donnerait l'illusion
  // d'un support qui n'existe pas, et le premier compte non vérifié se
  // retrouverait dans une impasse silencieuse. Refuser tant que le parcours
  // n'est pas écrit est le comportement honnête — et bruyant.
  const config = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
  const verifications =
    config.projectConfig.http?.authVerificationsPerActor?.merchant ?? []
  if (verifications.some((v) => v.auth_provider === "emailpass")) {
    logger.error(
      "POST /marchand/connexion : `authVerificationsPerActor.merchant` exige une vérification que cet écran n'implémente pas — connexion refusée. Écrire le parcours de vérification du back-office, ou retirer ce réglage."
    )
    return servirIncident(res, 500)
  }

  // Symétrique du `if (!req.session)` de la déconnexion : les deux routes
  // touchent la même session, et supposer sa présence d'un côté après
  // l'avoir vérifiée de l'autre est une asymétrie qui finit par se payer.
  // Ici, contrairement à la déconnexion, il n'y a rien à faire sans magasin
  // de session : on ne peut pas ouvrir de session, donc on ne prétend pas
  // avoir connecté qui que ce soit.
  if (!req.session) {
    logger.error(
      "POST /marchand/connexion : aucune session sur la requête — le magasin de sessions n'est pas monté. Connexion impossible."
    )
    return servirIncident(res, 500)
  }

  // Régénération avant de poser l'identité : sans elle, un identifiant de
  // session obtenu par un tiers AVANT la connexion resterait valable APRÈS,
  // et porterait alors les droits de la commerçante (fixation de session).
  // C'est ce que vérifie le test « change l'identifiant de session à chaque
  // connexion » : sans cet appel, express-session réutilise le sid présenté.
  await new Promise<void>((resoudre, rejeter) => {
    req.session.regenerate((e: unknown) => (e ? rejeter(e) : resoudre()))
  })

  // La session porte exactement ce que l'intergiciel d'authentification y
  // cherche (node_modules/@medusajs/framework/dist/http/middlewares/authenticate-middleware.js) :
  // un `actor_type` permis, et un `actor_id` non vide.
  req.session.auth_context = {
    actor_id: merchantId,
    actor_type: "merchant",
    auth_identity_id: authIdentity.id,
    app_metadata: authIdentity.app_metadata,
  }

  res.redirect(302, "/marchand")
}
