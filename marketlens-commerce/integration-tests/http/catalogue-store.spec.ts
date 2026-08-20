import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { servirVisionFactice } from "./helpers/vision-stub"

jest.setTimeout(90 * 1000)

const ZONE_TOMATES = { label: "Tomates", x: 250, y: 400, width: 200, height: 150, category: "fruits_legumes" }

/** Inscrit un marchand, se connecte et analyse une photo pour lui via la
 *  vraie route HTTP `POST /merchant/catalogues` (multipart). Ouvre son propre
 *  serveur de vision factice, fermé avant de retourner : les appelants n'ont
 *  pas à gérer eux-mêmes ce cycle de vie. */
async function inscrireEtAnalyser(api: any, handle: string, phone: string) {
  const email = `${handle}@marketlens.test`
  const inscription = await api.post("/auth/merchant/emailpass/register", {
    email,
    password: "motdepasse-de-test",
  })
  const creation = await api.post(
    "/merchant/register",
    { name: `Étal ${handle}`, handle, phone },
    { headers: { authorization: `Bearer ${inscription.data.token}` } }
  )
  const connexion = await api.post("/auth/merchant/emailpass", {
    email,
    password: "motdepasse-de-test",
  })
  const jeton = connexion.data.token
  // La route vitrine (/store/*) hérite de l'exigence globale du framework
  // sur tout le namespace /store — une clé publiable valide dans l'en-tête,
  // vérifiée AVANT que la requête n'atteigne notre route (voir
  // node_modules/@medusajs/framework/dist/http/router.js,
  // _ApiLoader_applyStorePublishableKeyMiddleware, montée sur le préfixe
  // /store entier, hors du système de matcher de src/api/middlewares.ts).
  // Notre route ignore volontairement à QUI appartient cette clé : la
  // vitrine est publique, pas cloisonnée par marchand.
  const publishableKey = creation.data.publishable_key

  const vision = await servirVisionFactice({
    detect: { products: [ZONE_TOMATES], count: 1 },
  })
  try {
    const form = new FormData()
    form.append(
      "image",
      new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" }),
      "etal.jpg"
    )
    form.append("title", `Catalogue de ${handle}`)

    const reponse = await api.post("/merchant/catalogues", form, {
      headers: { authorization: `Bearer ${jeton}` },
    })

    return {
      jeton,
      publishableKey,
      catalogueId: reponse.data.catalogue.id,
      catalogueHandle: reponse.data.catalogue.handle,
      zones: reponse.data.zones,
    }
  } finally {
    await vision.fermer()
  }
}

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Routes marchand et vitrine du catalogue visuel", () => {
      it("un marchand ne voit ni ne publie le catalogue d'un autre", async () => {
        const a = await inscrireEtAnalyser(api, "etal-cat-a", "22990009001")
        const b = await inscrireEtAnalyser(api, "etal-cat-b", "22990009002")

        // Liste : chacun ne voit que le sien
        const listeA = await api.get("/merchant/catalogues", {
          headers: { authorization: `Bearer ${a.jeton}` },
        })
        expect(listeA.data.catalogues.map((c: any) => c.id)).toEqual([a.catalogueId])
        expect(listeA.data.catalogues.map((c: any) => c.id)).not.toContain(b.catalogueId)

        // Publication croisée : A ne doit pas pouvoir publier le catalogue de B
        const croise = await api
          .post(
            `/merchant/catalogues/${b.catalogueId}/publish`,
            { items: [] },
            { headers: { authorization: `Bearer ${a.jeton}` } }
          )
          .catch((e: any) => e.response)
        expect(croise.status).toBe(404)
      })

      it("crée un brouillon avec ses zones via la route multipart, puis le publie sans que le corps ne porte ni zones ni image source", async () => {
        const marchand = await inscrireEtAnalyser(api, "etal-cat-publie", "22990009003")

        expect(marchand.catalogueId).toBeTruthy()
        expect(marchand.catalogueHandle).toBeTruthy()
        expect(marchand.zones).toHaveLength(1)
        expect(marchand.zones[0].id).toBeTruthy()

        // La région XOF n'existe pas encore : rien ne l'a créée dans cette
        // base de test dédiée à ce fichier avant la publication.
        const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
        const { data: regionsAvant } = await query.graph({
          entity: "region",
          fields: ["id", "currency_code"],
          filters: { currency_code: "xof" },
        })
        expect(regionsAvant).toHaveLength(0)

        const vision = await servirVisionFactice({
          detect: { products: [ZONE_TOMATES], count: 1 },
        })
        let publication: any
        try {
          // Le corps ne porte QUE `items` : ni zones, ni source_content, ni
          // source_filename, ni sales_channel_id, ni stock_location_id — la
          // route doit tout résoudre elle-même depuis la base.
          publication = await api.post(
            `/merchant/catalogues/${marchand.catalogueId}/publish`,
            {
              items: [
                {
                  zone_id: marchand.zones[0].id,
                  label: "Tomates fraîches",
                  price: "500",
                  quantity: 3,
                  colors: [],
                  sizes: [],
                },
              ],
            },
            { headers: { authorization: `Bearer ${marchand.jeton}` } }
          )
        } finally {
          await vision.fermer()
        }

        expect(publication.status).toBe(200)
        expect(publication.data.catalogue_id).toBe(marchand.catalogueId)
        expect(publication.data.product_ids).toHaveLength(1)
        expect(publication.data.annotated_image_url).toBeTruthy()

        // La preuve que la route a bien appelé assurerRegionXof avant de
        // lancer le workflow : la région XOF existe maintenant.
        const { data: regionsApres } = await query.graph({
          entity: "region",
          fields: ["id", "currency_code"],
          filters: { currency_code: "xof" },
        })
        expect(regionsApres.length).toBeGreaterThanOrEqual(1)

        // Republier un catalogue déjà publié est refusé (409), pas une
        // seconde exécution silencieuse.
        const rejoue = await api
          .post(
            `/merchant/catalogues/${marchand.catalogueId}/publish`,
            { items: [] },
            { headers: { authorization: `Bearer ${marchand.jeton}` } }
          )
          .catch((e: any) => e.response)
        expect(rejoue.status).toBe(409)
      })

      it("la vitrine publique n'expose un catalogue que s'il est publié, jamais son image source", async () => {
        const marchand = await inscrireEtAnalyser(api, "etal-cat-vitrine", "22990009004")

        // Brouillon : indiscernable d'un catalogue inexistant.
        const avantPublication = await api
          .get(`/store/catalogues/${marchand.catalogueHandle}`, {
            headers: { "x-publishable-api-key": marchand.publishableKey },
          })
          .catch((e: any) => e.response)
        expect(avantPublication.status).toBe(404)

        const vision = await servirVisionFactice({
          detect: { products: [ZONE_TOMATES], count: 1 },
        })
        try {
          await api.post(
            `/merchant/catalogues/${marchand.catalogueId}/publish`,
            {
              items: [
                {
                  zone_id: marchand.zones[0].id,
                  label: "Tomates de vitrine",
                  price: "750",
                  quantity: 2,
                  colors: [],
                  sizes: [],
                },
              ],
            },
            { headers: { authorization: `Bearer ${marchand.jeton}` } }
          )
        } finally {
          await vision.fermer()
        }

        const vitrine = await api.get(`/store/catalogues/${marchand.catalogueHandle}`, {
          headers: { "x-publishable-api-key": marchand.publishableKey },
        })
        expect(vitrine.status).toBe(200)
        expect(vitrine.data.catalogue.handle).toBe(marchand.catalogueHandle)
        expect(vitrine.data.catalogue.annotated_image_url).toBeTruthy()
        // L'image source non annotée n'est jamais exposée par la vitrine.
        expect(vitrine.data.catalogue.source_image_url).toBeUndefined()

        expect(vitrine.data.zones).toHaveLength(1)
        expect(vitrine.data.zones[0].product.title).toBe("Tomates de vitrine")
        expect(vitrine.data.zones[0].product.variants.length).toBeGreaterThanOrEqual(1)
      })

      it("une panne en aval de la publication (service de vision indisponible) rend 500, jamais 400 — ce n'est pas une erreur de saisie", async () => {
        const marchand = await inscrireEtAnalyser(api, "etal-cat-panne", "22990009005")

        // L'annotation intervient APRÈS la création des produits (comme dans
        // catalogue-publish.spec.ts) : la faire échouer exerce un vrai échec
        // d'infrastructure en aval de toute validation de saisie, pas une
        // entrée refusée à l'entrée du workflow.
        const vision = await servirVisionFactice({
          detect: { products: [ZONE_TOMATES], count: 1 },
          statutAnnotate: 502,
        })
        let reponse: any
        try {
          reponse = await api
            .post(
              `/merchant/catalogues/${marchand.catalogueId}/publish`,
              {
                items: [
                  {
                    zone_id: marchand.zones[0].id,
                    label: "Tomates fraîches",
                    price: "500",
                    quantity: 1,
                    colors: [],
                    sizes: [],
                  },
                ],
              },
              { headers: { authorization: `Bearer ${marchand.jeton}` } }
            )
            .catch((e: any) => e.response)
        } finally {
          await vision.fermer()
        }

        expect(reponse.status).toBe(500)
        // Message stable et générique : jamais le texte technique brut de
        // l'erreur d'origine (ici « Le service de vision a échoué (502) »,
        // mais ce pourrait être une contrainte Postgres ou un TypeError V8).
        expect(reponse.data.message).toBe(
          "La publication du catalogue a échoué. Réessayez plus tard."
        )
      })

      it("un article sans colors/sizes est refusé par un message français nommant l'article, pas un TypeError anglais brut", async () => {
        const marchand = await inscrireEtAnalyser(api, "etal-cat-forme", "22990009006")

        const vision = await servirVisionFactice({
          detect: { products: [ZONE_TOMATES], count: 1 },
        })
        let reponse: any
        try {
          reponse = await api
            .post(
              `/merchant/catalogues/${marchand.catalogueId}/publish`,
              {
                items: [
                  {
                    zone_id: marchand.zones[0].id,
                    label: "Tomates sans forme",
                    price: "500",
                    quantity: 1,
                    // colors et sizes délibérément absents.
                  },
                ],
              },
              { headers: { authorization: `Bearer ${marchand.jeton}` } }
            )
            .catch((e: any) => e.response)
        } finally {
          await vision.fermer()
        }

        expect(reponse.status).toBe(400)
        expect(reponse.data.message).toContain("Tomates sans forme")
        expect(reponse.data.message).toContain("couleurs")
      })
    })
  },
})
