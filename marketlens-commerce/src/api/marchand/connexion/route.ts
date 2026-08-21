import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { html } from "../../../lib/html"
import { page } from "../../../lib/pages/layout"
import { ECRAN_CONNEXION } from "../garde"

const MESSAGES: Record<string, string> = {
  inactif: "Votre compte n'est pas actif. Contactez l'équipe MarketLens.",
  identifiants: "Adresse ou mot de passe incorrect.",
  session: "Votre session a expiré. Reconnectez-vous.",
}

// Message unique pour TOUT échec de connexion, quelle qu'en soit la cause :
// adresse inconnue, mot de passe faux, ou identité qui existe mais n'est pas
// marchande. Distinguer ces cas transformerait cet écran en oracle
// d'existence de comptes.
const REFUS = `${ECRAN_CONNEXION}?erreur=identifiants`

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
  const { success, error, authIdentity } = await service.authenticate("emailpass", {
    actor_type: "merchant",
    url: req.url,
    headers: req.headers,
    query: req.query,
    body: { email, password: motdepasse },
    protocol: req.protocol,
  })

  if (!success || !authIdentity) {
    // Le détail technique va au journal ; la commerçante reçoit un message
    // unique, qui ne dit pas si c'est l'adresse ou le mot de passe qui cloche.
    logger.warn(`POST /marchand/connexion : identifiants refusés (${error ?? "cause inconnue"}).`)
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

  // Régénération avant de poser l'identité : sans elle, un identifiant de
  // session obtenu par un tiers AVANT la connexion resterait valable APRÈS,
  // et porterait alors les droits de la commerçante (fixation de session).
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
