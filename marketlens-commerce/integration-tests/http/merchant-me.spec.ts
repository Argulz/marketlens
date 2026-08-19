import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { MERCHANT_MODULE } from "../../src/modules/merchant"

jest.setTimeout(60 * 1000)

async function inscrireMarchand(api, email: string, handle: string, phone: string) {
  const inscription = await api.post("/auth/merchant/emailpass/register", {
    email, password: "motdepasse-de-test",
  })
  const creation = await api.post(
    "/merchant/register",
    { name: `Étal ${handle}`, handle, phone },
    { headers: { authorization: `Bearer ${inscription.data.token}` } }
  )
  const connexion = await api.post("/auth/merchant/emailpass", {
    email, password: "motdepasse-de-test",
  })
  return {
    jeton: connexion.data.token,
    merchantId: creation.data.merchant.id,
    publishableKey: creation.data.publishable_key,
  }
}

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("GET /merchant/me", () => {
      it("renvoie le marchand porté par le jeton", async () => {
        const fatou = await inscrireMarchand(api, "fatou@marketlens.test", "etal-fatou", "22990000001")

        const reponse = await api.get("/merchant/me", {
          headers: { authorization: `Bearer ${fatou.jeton}` },
        })

        expect(reponse.status).toBe(200)
        expect(reponse.data.merchant.id).toBe(fatou.merchantId)
        expect(reponse.data.merchant.handle).toBe("etal-fatou")
        expect(reponse.data.merchant.currency_code).toBe("xof")
      })

      it("refuse une requête sans jeton", async () => {
        const reponse = await api.get("/merchant/me").catch((e) => e.response)
        expect(reponse.status).toBe(401)
      })

      it("ne renvoie que les sept champs contractuels, sans les colonnes internes de suppression logique", async () => {
        const aissatou = await inscrireMarchand(api, "aissatou@marketlens.test", "etal-aissatou", "22990000002")

        const reponse = await api.get("/merchant/me", {
          headers: { authorization: `Bearer ${aissatou.jeton}` },
        })

        expect(reponse.status).toBe(200)
        // Assertion sur l'ensemble exact des clés présentes : une vérification
        // qui se contenterait de tester l'absence de created_at/updated_at/
        // deleted_at laisserait passer n'importe quel autre champ ajouté par
        // erreur plus tard (par exemple si le modèle DML gagne un champ que
        // la route oublierait de retirer de sa réponse façonnée).
        expect(Object.keys(reponse.data.merchant).sort()).toEqual(
          ["id", "name", "handle", "phone", "whatsapp_phone", "currency_code", "status"].sort()
        )
      })

      it("une identité rattachée à un marchand supprimé reçoit le message français attendu", async () => {
        const doudou = await inscrireMarchand(api, "doudou@marketlens.test", "etal-doudou", "22990000003")

        const merchantService: any = getContainer().resolve(MERCHANT_MODULE)
        await merchantService.deleteMerchants(doudou.merchantId)

        const reponse = await api
          .get("/merchant/me", { headers: { authorization: `Bearer ${doudou.jeton}` } })
          .catch((e) => e.response)

        expect(reponse.status).toBe(401)
        expect(reponse.data.message).toBe("Identité non rattachée à un marchand")
      })
    })
  },
})
