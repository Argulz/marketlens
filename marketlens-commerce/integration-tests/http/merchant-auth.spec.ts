import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import jwt from "jsonwebtoken"

jest.setTimeout(60 * 1000)

medusaIntegrationTestRunner({
  testSuite: ({ api }) => {
    describe("Inscription et authentification d'un marchand", () => {
      it("inscrit un marchand et lui délivre un jeton exploitable", async () => {
        const inscription = await api.post("/auth/merchant/emailpass/register", {
          email: "akosua@marketlens.test",
          password: "motdepasse-de-test",
        })
        expect(inscription.status).toBe(200)
        const jetonInscription = inscription.data.token

        // Avant l'inscription, le jeton ne porte encore aucun marchand :
        // c'est cette absence qui prouve que l'assertion suivante (après
        // l'appel à /merchant/register) constate un changement réel, et non
        // une valeur qui aurait déjà été présente par accident.
        const chargeAvant = jwt.decode(jetonInscription) as Record<string, any>
        expect(chargeAvant.app_metadata?.merchant_id).toBeUndefined()

        const creation = await api.post(
          "/merchant/register",
          { name: "Boutique d'Akosua", handle: "boutique-akosua", phone: "22990000021" },
          { headers: { authorization: `Bearer ${jetonInscription}` } }
        )
        expect(creation.status).toBe(200)
        expect(creation.data.merchant.handle).toBe("boutique-akosua")
        expect(creation.data.publishable_key).toMatch(/^pk_/)

        // Le jeton obtenu à la connexion doit désormais porter le marchand :
        // on décode le JWT et on vérifie que `app_metadata.merchant_id`
        // correspond exactement au marchand créé, et que l'acteur est
        // maintenant résolu (`actor_id`) — un simple statut 200 sur la
        // connexion ne prouverait pas que le rattachement a eu lieu.
        const connexion = await api.post("/auth/merchant/emailpass", {
          email: "akosua@marketlens.test",
          password: "motdepasse-de-test",
        })
        expect(connexion.status).toBe(200)
        expect(connexion.data.token).toBeTruthy()

        const chargeApres = jwt.decode(connexion.data.token) as Record<string, any>
        expect(chargeApres.app_metadata?.merchant_id).toBe(creation.data.merchant.id)
        expect(chargeApres.actor_id).toBe(creation.data.merchant.id)
        expect(chargeApres.actor_type).toBe("merchant")
      })

      it("refuse l'inscription sans jeton d'authentification", async () => {
        const reponse = await api
          .post("/merchant/register", {
            name: "Sans jeton", handle: "sans-jeton", phone: "22990000099",
          })
          .catch((e) => e.response)

        expect(reponse.status).toBe(401)
      })

      it("protège aussi une variante de casse d'une route marchand (régression de sensibilité à la casse)", async () => {
        // /merchant/me n'existe pas encore (tâche 4), mais peu importe : la
        // règle générale doit intercepter et répondre 401 *avant* même
        // qu'Express ne cherche un gestionnaire. Un 404 prouverait que le
        // matcher regex de la règle générale n'a pas matché cette variante
        // de casse (donc qu'il est redevenu sensible à la casse) et que la
        // requête est tombée à travers jusqu'au 404 par défaut d'Express —
        // exactement le contournement d'authentification que ce test
        // vérifie l'absence de.
        const reponse = await api
          .get("/Merchant/une-route-quelconque")
          .catch((e) => e.response)

        expect(reponse.status).toBe(401)
      })
    })
  },
})
