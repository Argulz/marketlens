import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import jwt from "jsonwebtoken"
import { MERCHANT_MODULE } from "../../src/modules/merchant"

jest.setTimeout(120000)

const MOT_DE_PASSE = "motdepasse-de-test"

/** Le back-office est un formulaire HTML, pas une API JSON : la connexion
 *  arrive en `application/x-www-form-urlencoded`. Poster du JSON ici
 *  testerait un chemin que le navigateur n'emprunte jamais. */
const formulaire = (champs: Record<string, string>) => ({
  corps: new URLSearchParams(champs).toString(),
  options: {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    maxRedirects: 0,
    validateStatus: () => true,
  },
})

/** Ne garde que les paires `nom=valeur` du `Set-Cookie`, sans les attributs
 *  (`Path`, `HttpOnly`, `Expires`) : renvoyer ces attributs dans un en-tête
 *  `Cookie` de requête n'a aucun sens et masquerait une vraie régression
 *  derrière un cookie mal formé. */
const cookieDe = (reponse: any): string =>
  ((reponse.headers["set-cookie"] as string[] | undefined) ?? [])
    .map((c) => c.split(";")[0])
    .join("; ")

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    /** Inscrit une identité marchande complète et rend de quoi se connecter. */
    const inscrireMarchand = async (
      email: string,
      name: string,
      handle: string,
      phone: string
    ) => {
      const insc = await api.post("/auth/merchant/emailpass/register", {
        email,
        password: MOT_DE_PASSE,
      })
      const creation = await api.post(
        "/merchant/register",
        { name, handle, phone },
        { headers: { authorization: `Bearer ${insc.data.token}` } }
      )
      return { merchantId: creation.data.merchant.id as string }
    }

    /** Passe par l'écran de connexion du back-office — pas par
     *  `/auth/session` — parce que c'est ce chemin-là qui porte le filtrage
     *  par type d'acteur qu'on veut voir à l'œuvre. */
    const seConnecter = async (email: string) => {
      const f = formulaire({ email, motdepasse: MOT_DE_PASSE })
      const r = await api.post("/marchand/connexion", f.corps, f.options)
      return { reponse: r, cookie: cookieDe(r) }
    }

    /**
     * Remplace, le temps d'un appel, la réponse du module d'authentification.
     *
     * C'est le SEUL montage honnête pour une panne amont : le module avale
     * toute exception et la rend sous forme de `{ success: false, error }`
     * (node_modules/@medusajs/auth/dist/services/auth-module.js, `authenticate`
     * — `catch (error) { return { success: false, error: error.message } }`).
     * Couper Postgres pendant un test n'est ni reproductible ni isolable ;
     * la seule chose que la route peut observer, elle, est bien ce contrat-là.
     */
    const avecAuthentification = async (
      resultat: Record<string, unknown>,
      corps: () => Promise<void>
    ) => {
      const authModule: any = getContainer().resolve(Modules.AUTH)
      const espion = jest
        .spyOn(authModule, "authenticate")
        .mockResolvedValue(resultat as never)
      try {
        await corps()
      } finally {
        espion.mockRestore()
      }
    }

    const posterConnexion = async (email: string, motdepasse: string) => {
      const f = formulaire({ email, motdepasse })
      return await api.post("/marchand/connexion", f.corps, f.options)
    }

    describe("Accès au back-office marchand", () => {
      it("sert l'écran de connexion à qui n'a aucune session", async () => {
        const r = await api.get("/marchand/connexion", {
          maxRedirects: 0,
          validateStatus: () => true,
        })
        expect(r.status).toBe(200)
        expect(r.headers["content-type"]).toContain("text/html")
        expect(r.data).toContain('action="/marchand/connexion"')
      })

      it("redirige vers la connexion quand aucune session n'est ouverte", async () => {
        const r = await api.get("/marchand", {
          maxRedirects: 0,
          validateStatus: () => true,
        })
        expect(r.status).toBe(302)
        expect(r.headers.location).toBe("/marchand/connexion")
      })

      it("sert la liste après connexion, et le nom de la boutique y figure échappé", async () => {
        const email = "garde-bo@marketlens.test"
        await inscrireMarchand(
          email,
          `Étal <b>Aïcha</b>`,
          "etal-bo-garde",
          "22990000061"
        )

        const { reponse, cookie } = await seConnecter(email)
        expect(reponse.status).toBe(302)
        expect(reponse.headers.location).toBe("/marchand")
        expect(cookie).toBeTruthy()

        const page = await api.get("/marchand", { headers: { cookie } })
        expect(page.status).toBe(200)
        expect(page.headers["content-type"]).toContain("text/html")
        // Le nom hostile ressort échappé : c'est la garantie qui compte.
        expect(page.data).toContain("&lt;b&gt;Aïcha&lt;/b&gt;")
        expect(page.data).not.toContain("<b>Aïcha</b>")
      })

      it("renvoie un marchand suspendu vers la connexion, sans rien lui servir", async () => {
        const email = "suspendu-bo@marketlens.test"
        const { merchantId } = await inscrireMarchand(
          email,
          "Étal suspendu",
          "etal-bo-suspendu",
          "22990000062"
        )
        const { cookie } = await seConnecter(email)
        expect(cookie).toBeTruthy()

        const service: any = getContainer().resolve(MERCHANT_MODULE)
        await service.updateMerchants({ id: merchantId, status: "suspended" })

        const page = await api.get("/marchand", {
          headers: { cookie },
          maxRedirects: 0,
          validateStatus: () => true,
        })
        expect(page.status).toBe(302)
        expect(page.headers.location).toBe("/marchand/connexion?erreur=inactif")
        expect(page.data).not.toContain("Étal suspendu")
      })

      it("refuse un mot de passe incorrect sans dire lequel des deux champs cloche", async () => {
        const email = "motdepasse-bo@marketlens.test"
        await inscrireMarchand(
          email,
          "Étal mot de passe",
          "etal-bo-motdepasse",
          "22990000063"
        )

        const f = formulaire({ email, motdepasse: "ce-n-est-pas-le-bon" })
        const r = await api.post("/marchand/connexion", f.corps, f.options)
        expect(r.status).toBe(302)
        expect(r.headers.location).toBe("/marchand/connexion?erreur=identifiants")

        // Aucune session utilisable ne doit être posée par un échec.
        const page = await api.get("/marchand", {
          headers: { cookie: cookieDe(r) },
          maxRedirects: 0,
          validateStatus: () => true,
        })
        expect(page.status).toBe(302)
        expect(page.headers.location).toBe("/marchand/connexion")
      })

      // C'est LE contrôle de sécurité propre à cet écran. `emailpass` ne
      // consulte jamais `actor_type` : il retrouve l'identité par l'adresse
      // e-mail seule (node_modules/@medusajs/auth-emailpass/dist/services/emailpass.js).
      // Une identité de cliente ou d'administrateur portant la même adresse
      // s'authentifie donc « avec succès », et le framework, lui, n'échoue pas
      // non plus : il émettrait un contexte avec `actor_id: ""`
      // (node_modules/@medusajs/medusa/dist/api/auth/utils/generate-jwt-token.js:61-63).
      // Le filtrage par `merchant_id` doit donc être fait ici, à la main.
      it("refuse une identité non marchande avec le même message que des identifiants faux", async () => {
        const email = "cliente-bo@marketlens.test"
        const insc = await api.post("/auth/customer/emailpass/register", {
          email,
          password: MOT_DE_PASSE,
        })
        expect(insc.status).toBe(200)

        // On rattache l'identité à un acteur *cliente* : le montage honnête
        // n'est pas une identité orpheline, c'est une identité valide d'un
        // autre type d'acteur — le cas qui doit être refusé.
        const charge = jwt.decode(insc.data.token) as Record<string, any>
        const authModule: any = getContainer().resolve(Modules.AUTH)
        await authModule.updateAuthIdentities({
          id: charge.auth_identity_id,
          app_metadata: { customer_id: "cus_faux_back_office" },
        })

        const { reponse, cookie } = await seConnecter(email)
        expect(reponse.status).toBe(302)
        // Message strictement identique à celui d'un mot de passe faux :
        // rien ne doit révéler que cette adresse existe côté cliente.
        expect(reponse.headers.location).toBe(
          "/marchand/connexion?erreur=identifiants"
        )

        // Et surtout : aucune session utilisable n'a été posée.
        const page = await api.get("/marchand", {
          headers: cookie ? { cookie } : {},
          maxRedirects: 0,
          validateStatus: () => true,
        })
        expect(page.status).toBe(302)
        expect(page.headers.location).toBe("/marchand/connexion")
      })

      it("détruit la session à la déconnexion", async () => {
        const email = "sortie-bo@marketlens.test"
        await inscrireMarchand(
          email,
          "Étal sortie",
          "etal-bo-sortie",
          "22990000064"
        )
        const { cookie } = await seConnecter(email)

        const sortie = await api.get("/marchand/deconnexion", {
          headers: { cookie },
          maxRedirects: 0,
          validateStatus: () => true,
        })
        expect(sortie.status).toBe(302)
        expect(sortie.headers.location).toBe("/marchand/connexion")

        // Le cookie d'origine ne doit plus rien ouvrir : c'est la session
        // côté serveur qui est détruite, pas seulement le cookie effacé chez
        // la commerçante.
        const page = await api.get("/marchand", {
          headers: { cookie },
          maxRedirects: 0,
          validateStatus: () => true,
        })
        expect(page.status).toBe(302)
        expect(page.headers.location).toBe("/marchand/connexion")
      })

      // Régression de sensibilité à la casse, jumelle de celle de
      // merchant-auth.spec.ts. Un matcher `RegExp` est utilisé tel quel par
      // Express, contrairement à un matcher chaîne : sans le drapeau `i`,
      // `/Marchand/...` ne matche aucune règle d'intergiciel et tombe
      // directement sur le 404 d'Express — donc toute route de page ajoutée
      // ensuite sous /marchand/* naîtrait hors de toute authentification.
      // Un 302 prouve que l'intergiciel intercepte AVANT qu'Express ne
      // cherche un gestionnaire ; un 404 prouverait que le trou est ouvert.
      it("protège aussi les variantes de casse des pages du back-office", async () => {
        const r = await api.get("/Marchand/une-page-inexistante", {
          maxRedirects: 0,
          validateStatus: () => true,
        })
        expect(r.status).toBe(302)
        expect(r.headers.location).toBe("/marchand/connexion")
      })

      // Corollaire du test précédent : l'intergiciel refuse AVANT le routage,
      // y compris en minuscules. C'est ce qui rend l'oubli impossible par
      // construction — une page ajoutée plus tard sous /marchand/* n'a aucune
      // garde à appeler, elle reçoit `req.marchand` déjà résolu.
      it("refuse une page inconnue du back-office avant même de la router", async () => {
        const r = await api.get("/marchand/une-page-inexistante", {
          maxRedirects: 0,
          validateStatus: () => true,
        })
        expect(r.status).toBe(302)
        expect(r.headers.location).toBe("/marchand/connexion")
      })

      // Le cas le plus fréquent en pratique : quelqu'un s'inscrit par
      // /auth/merchant/emailpass/register puis abandonne avant
      // /merchant/register. L'identité existe, le mot de passe est bon,
      // `app_metadata` est vide — et rien ne doit s'ouvrir.
      it("refuse une identité inscrite mais jamais rattachée à une boutique", async () => {
        const email = "orpheline-bo@marketlens.test"
        const insc = await api.post("/auth/merchant/emailpass/register", {
          email,
          password: MOT_DE_PASSE,
        })
        expect(insc.status).toBe(200)
        // Aucun appel à /merchant/register : `app_metadata` reste vide.

        const { reponse, cookie } = await seConnecter(email)
        expect(reponse.status).toBe(302)
        expect(reponse.headers.location).toBe(
          "/marchand/connexion?erreur=identifiants"
        )

        const page = await api.get("/marchand", {
          headers: cookie ? { cookie } : {},
          maxRedirects: 0,
          validateStatus: () => true,
        })
        expect(page.status).toBe(302)
        expect(page.headers.location).toBe("/marchand/connexion")
      })

      // Les deux tests précédents écrivent chacun le littéral attendu : rien
      // ne verrouille leur ÉGALITÉ, qui est pourtant la propriété qui compte
      // (ne pas transformer l'écran en oracle d'existence de comptes). Ce
      // test-ci ne regarde aucun littéral : il compare les deux redirections
      // l'une à l'autre.
      it("rend la même redirection pour une adresse inconnue et pour une identité d'un autre acteur", async () => {
        const inconnue = await posterConnexion(
          "personne-nexiste-pas-bo@marketlens.test",
          MOT_DE_PASSE
        )
        expect(inconnue.status).toBe(302)

        const email = "cliente2-bo@marketlens.test"
        const insc = await api.post("/auth/customer/emailpass/register", {
          email,
          password: MOT_DE_PASSE,
        })
        const charge = jwt.decode(insc.data.token) as Record<string, any>
        const authModule: any = getContainer().resolve(Modules.AUTH)
        await authModule.updateAuthIdentities({
          id: charge.auth_identity_id,
          app_metadata: { customer_id: "cus_faux_back_office_2" },
        })

        const autreActeur = await posterConnexion(email, MOT_DE_PASSE)
        expect(autreActeur.status).toBe(inconnue.status)
        expect(autreActeur.headers.location).toBe(inconnue.headers.location)
      })

      // Anti-fixation de session. `req.session.regenerate()` est la seule
      // propriété de sécurité de cet écran qu'aucune assertion ne couvrait :
      // on pouvait retirer l'appel sans qu'un seul test ne rougisse.
      // On rejoue donc la connexion EN PRÉSENTANT le cookie de la première :
      // sans régénération, express-session réutilise le même identifiant et
      // un identifiant obtenu AVANT la connexion resterait valable APRÈS.
      it("change l'identifiant de session à chaque connexion", async () => {
        const email = "fixation-bo@marketlens.test"
        await inscrireMarchand(
          email,
          "Étal fixation",
          "etal-bo-fixation",
          "22990000065"
        )

        const premiere = await seConnecter(email)
        expect(premiere.reponse.status).toBe(302)
        expect(premiere.cookie).toBeTruthy()

        const f = formulaire({ email, motdepasse: MOT_DE_PASSE })
        const seconde = await api.post("/marchand/connexion", f.corps, {
          ...f.options,
          headers: { ...f.options.headers, cookie: premiere.cookie },
        })
        expect(seconde.status).toBe(302)

        const cookieSeconde = cookieDe(seconde)
        expect(cookieSeconde).toBeTruthy()
        expect(cookieSeconde).not.toBe(premiere.cookie)
      })

      // Contrainte globale du lot : une panne amont sort en 5xx, jamais en
      // 4xx accusant la saisie de la commerçante. Le module
      // d'authentification avale les exceptions et les rend indistinctement
      // de mots de passe faux ; c'est donc à la route de trier.
      it("sort en 5xx, et non en « mot de passe incorrect », quand l'authentification tombe en panne", async () => {
        await avecAuthentification(
          {
            success: false,
            error: "terminating connection due to administrator command",
          },
          async () => {
            const r = await posterConnexion(
              "panne-bo@marketlens.test",
              MOT_DE_PASSE
            )
            expect(r.status).toBe(503)
            expect(r.headers.location).toBeUndefined()
          }
        )
      })

      // Un défi MFA NON RÉSOLU rend `{ success: true, authIdentity }` :
      // `applyMfaRequirement_` (auth-module.js) le pose sans rien avoir
      // vérifié, et la route du framework se contente d'émettre un jeton
      // SANS acteur. Un `success && authIdentity` naïf poserait ici une
      // session pleinement privilégiée en sautant le second facteur.
      // Idem pour `location`, qui signale une redirection vers un
      // fournisseur externe : l'identité n'est pas encore prouvée.
      it("refuse la connexion, distinctement d'identifiants faux, si le module réclame un second facteur ou une redirection", async () => {
        await avecAuthentification(
          {
            success: true,
            mfaChallenge: { id: "amc_faux" },
            authIdentity: {
              id: "authid_mfa",
              app_metadata: { merchant_id: "mer_quelconque" },
            },
          },
          async () => {
            const r = await posterConnexion(
              "mfa-bo@marketlens.test",
              MOT_DE_PASSE
            )
            expect(r.status).toBe(500)
            expect(r.headers.location).toBeUndefined()
            const page = await api.get("/marchand", {
              headers: { cookie: cookieDe(r) },
              maxRedirects: 0,
              validateStatus: () => true,
            })
            expect(page.status).toBe(302)
            expect(page.headers.location).toBe("/marchand/connexion")
          }
        )

        await avecAuthentification(
          { success: true, location: "https://ailleurs.test/oauth" },
          async () => {
            const r = await posterConnexion(
              "oauth-bo@marketlens.test",
              MOT_DE_PASSE
            )
            expect(r.status).toBe(500)
            expect(r.headers.location).toBeUndefined()
          }
        )
      })

      // Jumeau du précédent, pour la vérification d'adresse e-mail. Le
      // framework la fait respecter par `validateVerification`
      // (node_modules/@medusajs/medusa/dist/api/auth/utils/validate-verification.js),
      // appelé depuis `generateJwtTokenWithChecks` — donc uniquement sur la
      // route `/auth/<acteur>/<fournisseur>`. Cet écran-ci ne passe pas par
      // là : sans ce contrôle, activer `authVerificationsPerActor` ferait
      // respecter la vérification côté API et l'ignorer complètement côté
      // back-office.
      //
      // La configuration est modifiée le temps du test puis restaurée : c'est
      // le seul moyen d'observer un chemin qu'aucun réglage du dépôt
      // n'emprunte aujourd'hui — et c'est précisément parce qu'il est inerte
      // qu'il fallait l'écrire avant qu'il ne cesse de l'être.
      it("refuse la connexion si une vérification d'e-mail est exigée pour les marchandes", async () => {
        const email = "verif-bo@marketlens.test"
        await inscrireMarchand(
          email,
          "Étal vérification",
          "etal-bo-verification",
          "22990000066"
        )

        const config: any = getContainer().resolve(
          ContainerRegistrationKeys.CONFIG_MODULE
        )
        const initial = config.projectConfig.http.authVerificationsPerActor
        config.projectConfig.http.authVerificationsPerActor = {
          merchant: [{ entity_type: "email", auth_provider: "emailpass" }],
        }

        try {
          const r = await posterConnexion(email, MOT_DE_PASSE)
          expect(r.status).toBe(500)
          expect(r.headers.location).toBeUndefined()

          const page = await api.get("/marchand", {
            headers: { cookie: cookieDe(r) },
            maxRedirects: 0,
            validateStatus: () => true,
          })
          expect(page.status).toBe(302)
          expect(page.headers.location).toBe("/marchand/connexion")
        } finally {
          config.projectConfig.http.authVerificationsPerActor = initial
        }
      })
    })
  },
})
