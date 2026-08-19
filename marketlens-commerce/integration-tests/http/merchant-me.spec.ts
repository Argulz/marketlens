import { medusaIntegrationTestRunner } from "@medusajs/test-utils"

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
  testSuite: ({ api }) => {
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
    })
  },
})
