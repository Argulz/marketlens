import { medusaIntegrationTestRunner } from "@medusajs/test-utils"

jest.setTimeout(90 * 1000)

// `medusaIntegrationTestRunner` réinitialise la base entre deux `it` : chaque
// test crée donc ses propres identités et ses propres marchands, et aucun ne
// dépend de l'ordre d'exécution.
async function jetonInscription(api, email: string): Promise<string> {
  const reponse = await api.post("/auth/merchant/emailpass/register", {
    email, password: "motdepasse-de-test",
  })
  return reponse.data.token
}

async function jetonConnexion(api, email: string): Promise<string> {
  const reponse = await api.post("/auth/merchant/emailpass", {
    email, password: "motdepasse-de-test",
  })
  return reponse.data.token
}

async function inscrire(api, jeton: string, corps: unknown) {
  return api
    .post("/merchant/register", corps, {
      headers: { authorization: `Bearer ${jeton}` },
    })
    .catch((e) => e.response)
}

medusaIntegrationTestRunner({
  testSuite: ({ api }) => {
    describe("POST /merchant/register — validation du corps", () => {
      it("refuse un handle qui n'est pas un slug", async () => {
        // `../admin` était accepté et persisté tel quel : un handle est
        // destiné à devenir un segment d'URL publique (`/c/[handle]`).
        const jeton = await jetonInscription(api, "nafi@marketlens.test")
        const reponse = await inscrire(api, jeton, {
          name: "Traversée", handle: "../admin", phone: "22990000051",
        })

        expect(reponse.status).toBe(400)
        expect(reponse.data.message).toContain("handle")
        expect(reponse.data.message).toMatch(/minuscules/)
      })

      it("refuse un handle qui n'est pas une chaîne", async () => {
        // `handle: ["x"]` renvoyait 200 et persistait `"x"` par coercition
        // silencieuse.
        const jeton = await jetonInscription(api, "nafi@marketlens.test")
        const reponse = await inscrire(api, jeton, {
          name: "Tableau", handle: ["x"], phone: "22990000052",
        })

        expect(reponse.status).toBe(400)
        expect(reponse.data.message).toContain("handle")
      })

      it("refuse un name ou un phone qui ne sont pas des chaînes", async () => {
        // `name: {a:1}` produisait un canal de vente nommé
        // « Boutique [object Object] ».
        const jeton = await jetonInscription(api, "nafi@marketlens.test")
        const reponse = await inscrire(api, jeton, {
          name: { a: 1 }, handle: "etal-objet", phone: 12345,
        })

        expect(reponse.status).toBe(400)
        expect(reponse.data.message).toContain("name")
        expect(reponse.data.message).toContain("phone")
      })

      it("refuse un corps incomplet", async () => {
        const jeton = await jetonInscription(api, "nafi@marketlens.test")
        const reponse = await inscrire(api, jeton, { handle: "etal-incomplet" })

        expect(reponse.status).toBe(400)
        expect(reponse.data.message).toContain("name")
        expect(reponse.data.message).toContain("phone")
      })

      it("normalise le handle en minuscules et renvoie l'entité persistée, pas l'écho du corps reçu", async () => {
        const jeton = await jetonInscription(api, "nafi@marketlens.test")
        const reponse = await inscrire(api, jeton, {
          name: "  Étal de Nafi  ", handle: "ETAL-NAFI", phone: "22990000053",
        })

        expect(reponse.status).toBe(200)
        // Le client a envoyé « ETAL-NAFI » ; c'est « etal-nafi » qui est en
        // base. Renvoyer l'écho du corps reçu ferait croire au client que son
        // handle est celui qu'il a écrit.
        expect(reponse.data.merchant.handle).toBe("etal-nafi")
        expect(reponse.data.merchant.name).toBe("Étal de Nafi")
        expect(reponse.data.merchant.currency_code).toBe("xof")
        // Provisionné par le workflow, donc actif — et non `pending`, valeur
        // par défaut du modèle.
        expect(reponse.data.merchant.status).toBe("active")
        expect(Object.keys(reponse.data.merchant).sort()).toEqual(
          ["id", "name", "handle", "phone", "whatsapp_phone", "currency_code", "status"].sort()
        )
        expect(reponse.data.publishable_key).toMatch(/^pk_/)
      })

      it("refuse en 409 français un handle déjà pris, y compris dans une autre casse", async () => {
        // C'est la ligne qui mord : l'index unique de Postgres est sensible à
        // la casse, donc sans normalisation `etal-nafi` et `ETAL-NAFI`
        // coexistaient — deux locataires distincts qui se disputeraient la
        // même URL de catalogue dès que le routage minusculiserait le segment.
        const nafi = await jetonInscription(api, "nafi@marketlens.test")
        const premiere = await inscrire(api, nafi, {
          name: "Étal de Nafi", handle: "etal-nafi", phone: "22990000053",
        })
        expect(premiere.status).toBe(200)

        const binta = await jetonInscription(api, "binta@marketlens.test")
        const reponse = await inscrire(api, binta, {
          name: "Étal de Binta", handle: "Etal-Nafi", phone: "22990000054",
        })

        expect(reponse.status).toBe(409)
        expect(reponse.data.message).toContain("etal-nafi")
        expect(reponse.data.message).toMatch(/déjà utilisé/)
      })

      it("refuse en 409 français une identité déjà rattachée à un marchand", async () => {
        // Le jeton de connexion porte `actor_id` : la route refuse avant de
        // toucher au workflow. Sans cette garde, chaque double-clic du
        // back-office provisionnait un canal, un emplacement et une clé avant
        // de tout compenser, pour finir sur un 500 anglais.
        const moussa = await jetonInscription(api, "moussa@marketlens.test")
        const premiere = await inscrire(api, moussa, {
          name: "Étal de Moussa", handle: "etal-moussa", phone: "22990000055",
        })
        expect(premiere.status).toBe(200)

        const jetonConnecte = await jetonConnexion(api, "moussa@marketlens.test")
        const reponse = await inscrire(api, jetonConnecte, {
          name: "Second étal", handle: "etal-moussa-bis", phone: "22990000056",
        })

        expect(reponse.status).toBe(409)
        expect(reponse.data.message).toMatch(/déjà rattachée/)
      })

      it("refuse en 409 français la réutilisation du jeton d'inscription après une inscription réussie", async () => {
        // Variante du cas précédent : le jeton d'inscription, lui, ne porte
        // pas `actor_id` (le contexte d'authentification est reconstruit
        // depuis la charge du JWT, pas relu en base). La garde d'entrée ne le
        // voit donc pas ; c'est `setAuthAppMetadataStep` qui échoue en aval
        // (« Key merchant_id already exists in app metadata »). Ce chemin
        // rendait un 500 anglais ; il doit rendre le même 409 français.
        const awa = await jetonInscription(api, "awa@marketlens.test")
        const premiere = await inscrire(api, awa, {
          name: "Étal d'Awa", handle: "etal-awa", phone: "22990000057",
        })
        expect(premiere.status).toBe(200)

        const reponse = await inscrire(api, awa, {
          name: "Étal d'Awa bis", handle: "etal-awa-bis", phone: "22990000058",
        })

        expect(reponse.status).toBe(409)
        expect(reponse.data.message).toMatch(/déjà rattachée/)
      })
    })
  },
})
