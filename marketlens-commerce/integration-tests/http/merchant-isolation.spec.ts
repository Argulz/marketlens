import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { createProductsWorkflow } from "@medusajs/medusa/core-flows"

jest.setTimeout(90 * 1000)

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

// Résout le sales channel lié au marchand via le service de requête. Les
// liens créés par le workflow de provisionnement (tâche 2) sont exposés par
// `query.graph` sous le champ singulier `sales_channel` (observé, pas
// supposé : vérifié par une requête réelle à la tâche 2). Interroger ce lien
// ici vérifie au passage qu'il existe réellement — s'il n'existait pas ou
// pointait vers le mauvais canal, `data[0].sales_channel` serait absent ou
// incohérent et l'accès à `.id` lèverait ou renverrait une valeur fausse.
async function recupererCanal(container, merchantId: string): Promise<string> {
  const query = container.resolve("query")
  const { data } = await query.graph({
    entity: "merchant",
    fields: ["id", "sales_channel.*"],
    filters: { id: merchantId },
  })
  return data[0].sales_channel.id
}

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Isolation entre marchands", () => {
      it("aucune donnée ne franchit la frontière entre deux marchands", async () => {
        const yaa = await inscrireMarchand(api, "yaa@marketlens.test", "etal-yaa", "22990000031")
        const kwame = await inscrireMarchand(api, "kwame@marketlens.test", "etal-kwame", "22990000032")

        expect(yaa.merchantId).not.toBe(kwame.merchantId)
        expect(yaa.publishableKey).not.toBe(kwame.publishableKey)

        // --- 1. Le jeton de Yaa ne donne accès qu'à Yaa ---
        const moiYaa = await api.get("/merchant/me", {
          headers: { authorization: `Bearer ${yaa.jeton}` },
        })
        expect(moiYaa.data.merchant.id).toBe(yaa.merchantId)
        expect(moiYaa.data.merchant.handle).toBe("etal-yaa")

        const moiKwame = await api.get("/merchant/me", {
          headers: { authorization: `Bearer ${kwame.jeton}` },
        })
        expect(moiKwame.data.merchant.id).toBe(kwame.merchantId)

        // --- 2. Un produit du canal de Yaa est invisible avec la clé de Kwame ---
        const canalYaa = await recupererCanal(getContainer(), yaa.merchantId)
        const canalKwame = await recupererCanal(getContainer(), kwame.merchantId)
        expect(canalYaa).not.toBe(canalKwame)

        const { result: produits } = await createProductsWorkflow(getContainer()).run({
          input: {
            products: [
              {
                title: "Tomates de Yaa",
                status: "published",
                options: [{ title: "Défaut", values: ["unique"] }],
                variants: [
                  { title: "unique", options: { "Défaut": "unique" }, manage_inventory: false },
                ],
                sales_channels: [{ id: canalYaa }],
              },
            ],
          },
        })
        expect(produits[0].id).toBeTruthy()

        const vuParYaa = await api.get("/store/products", {
          headers: { "x-publishable-api-key": yaa.publishableKey },
        })
        expect(vuParYaa.data.products.map((p) => p.title)).toContain("Tomates de Yaa")

        const vuParKwame = await api.get("/store/products", {
          headers: { "x-publishable-api-key": kwame.publishableKey },
        })
        expect(vuParKwame.data.products.map((p) => p.title)).not.toContain("Tomates de Yaa")

        // --- 3. Une requête sans clé publiable ne voit rien ---
        const sansCle = await api.get("/store/products").catch((e) => e.response)
        expect([400, 401]).toContain(sansCle.status)
      })
    })
  },
})
