import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
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
      // y compris en minuscules. Sans cela, une page ajoutée plus tard sous
      // /marchand/* et dont l'auteur oublierait `pageMarchandOuRedirection`
      // serait entièrement publique.
      it("refuse une page inconnue du back-office avant même de la router", async () => {
        const r = await api.get("/marchand/une-page-inexistante", {
          maxRedirects: 0,
          validateStatus: () => true,
        })
        expect(r.status).toBe(302)
        expect(r.headers.location).toBe("/marchand/connexion")
      })
    })
  },
})
