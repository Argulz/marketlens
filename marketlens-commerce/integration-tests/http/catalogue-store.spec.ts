import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { servirVisionFactice } from "./helpers/vision-stub"
import { TAILLE_MAX_IMAGE_MO } from "../../src/lib/limites-image"

jest.setTimeout(90 * 1000)

const ZONE_TOMATES = { label: "Tomates", x: 250, y: 400, width: 200, height: 150, category: "fruits_legumes" }

/** Inscrit un marchand et le connecte, sans rien analyser : les tests qui
 *  éprouvent le refus de la route (photo trop lourde, service de vision en
 *  panne) ne peuvent pas passer par une analyse réussie. */
async function inscrire(api: any, handle: string, phone: string) {
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
  // La route vitrine (/store/*) hérite de l'exigence globale du framework
  // sur tout le namespace /store — une clé publiable valide dans l'en-tête,
  // vérifiée AVANT que la requête n'atteigne notre route (voir
  // node_modules/@medusajs/framework/dist/http/router.js,
  // _ApiLoader_applyStorePublishableKeyMiddleware, montée sur le préfixe
  // /store entier, hors du système de matcher de src/api/middlewares.ts).
  // Notre route ignore volontairement à QUI appartient cette clé : la
  // vitrine est publique, pas cloisonnée par marchand.
  return {
    jeton: connexion.data.token,
    publishableKey: creation.data.publishable_key,
  }
}

/** Corps multipart d'une photo d'étal minimale (quatre octets d'en-tête
 *  JPEG) : cette suite n'éprouve jamais le décodage de l'image, seulement le
 *  chemin qui la porte. */
function corpsPhoto(titre: string): FormData {
  const form = new FormData()
  form.append(
    "image",
    new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" }),
    "etal.jpg"
  )
  form.append("title", titre)
  return form
}

/** Inscrit un marchand, se connecte et analyse une photo pour lui via la
 *  vraie route HTTP `POST /merchant/catalogues` (multipart). Ouvre son propre
 *  serveur de vision factice, fermé avant de retourner : les appelants n'ont
 *  pas à gérer eux-mêmes ce cycle de vie. */
async function inscrireEtAnalyser(api: any, handle: string, phone: string) {
  const { jeton, publishableKey } = await inscrire(api, handle, phone)

  const vision = await servirVisionFactice({
    detect: { products: [ZONE_TOMATES], count: 1 },
  })
  try {
    const reponse = await api.post(
      "/merchant/catalogues",
      corpsPhoto(`Catalogue de ${handle}`),
      { headers: { authorization: `Bearer ${jeton}` } }
    )

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

      it("refuse une photo au-delà de la limite par un message français nommant la limite, jamais par un 500", async () => {
        // `multer.memoryStorage()` sans `limits` bufférisait TOUTE la photo en
        // mémoire, puis la convertissait en chaîne "binary" — deux à trois
        // copies du fichier par requête concurrente, sans plafond, sur une
        // route ouverte à tout marchand authentifié.
        const marchand = await inscrire(api, "etal-cat-lourd", "22990009007")

        const form = new FormData()
        form.append(
          "image",
          new Blob([Buffer.alloc((TAILLE_MAX_IMAGE_MO + 1) * 1024 * 1024)], {
            type: "image/jpeg",
          }),
          "enorme.jpg"
        )
        form.append("title", "Étal trop lourd")

        const reponse = await api
          .post("/merchant/catalogues", form, {
            headers: { authorization: `Bearer ${marchand.jeton}` },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          })
          .catch((e: any) => e.response)

        expect(reponse.status).toBe(400)
        expect(reponse.data.message).toContain(`${TAILLE_MAX_IMAGE_MO} Mo`)
        // Le message de multer (« File too large ») est anglais : il ne doit
        // jamais atteindre le marchand.
        expect(reponse.data.message).not.toMatch(/File too large/i)
      })

      it("refuse un envoi de plusieurs images par un message français, sans faire travailler la vision", async () => {
        // `limits.files: 1` ferme la variante par le NOMBRE : sans plafond,
        // `upload.array("image")` bufferisait autant de fichiers que
        // l'appelant en envoyait, alors que la route n'en lit qu'un
        // (`req.files?.[0]`) — le reste était copié en mémoire pour rien.
        const marchand = await inscrire(api, "etal-cat-multi", "22990009010")

        const form = corpsPhoto("Étal à deux images")
        form.append(
          "image",
          new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe1])], { type: "image/jpeg" }),
          "etal-bis.jpg"
        )

        const reponse = await api
          .post("/merchant/catalogues", form, {
            headers: { authorization: `Bearer ${marchand.jeton}` },
          })
          .catch((e: any) => e.response)

        expect(reponse.status).toBe(400)
        expect(reponse.data.message).toContain("une seule image")
      })

      it("traduit un refus du service de vision en 400 français actionnable, sans exposer le détail technique", async () => {
        // Le service de vision refuse en 413 au-delà de sa propre limite, et
        // en 400 une image illisible. Sans try/catch dans la route, le
        // framework rendait un 500 portant le texte technique « Le service de
        // vision a refusé la requête (413) » — un cas NOMINAL (photo de
        // téléphone récent) traité comme une panne serveur.
        const marchand = await inscrire(api, "etal-cat-refus", "22990009008")

        const vision = await servirVisionFactice({ statutDetect: 413 })
        let reponse: any
        try {
          reponse = await api
            .post("/merchant/catalogues", corpsPhoto("Étal refusé"), {
              headers: { authorization: `Bearer ${marchand.jeton}` },
            })
            .catch((e: any) => e.response)
        } finally {
          await vision.fermer()
        }

        expect(reponse.status).toBe(400)
        // Actionnable : le marchand apprend quoi faire, et la limite en Mo.
        expect(reponse.data.message).toContain(`${TAILLE_MAX_IMAGE_MO} Mo`)
        // Aucun détail technique : ni le code amont, ni le nom du service.
        expect(reponse.data.message).not.toContain("413")
        expect(reponse.data.message).not.toMatch(/refus[ée] la requ[êe]te/i)
      })

      it("traduit une indisponibilité du service de vision en 503 français, jamais en 400", async () => {
        // Une panne amont doit rester visible en supervision comme un 5xx :
        // la compter en 400 la ferait passer pour une faute du marchand.
        const marchand = await inscrire(api, "etal-cat-503", "22990009009")

        const vision = await servirVisionFactice({ statutDetect: 503 })
        let reponse: any
        try {
          reponse = await api
            .post("/merchant/catalogues", corpsPhoto("Étal en panne"), {
              headers: { authorization: `Bearer ${marchand.jeton}` },
            })
            .catch((e: any) => e.response)
        } finally {
          await vision.fermer()
        }

        expect(reponse.status).toBe(503)
        expect(reponse.data.message).toMatch(/indisponible/i)
        // Le détail technique (« Le service de vision a échoué (503) ») reste
        // dans les journaux du serveur.
        expect(reponse.data.message).not.toContain("(503)")
      })

      it("traduit un quota Gemini épuisé (429 amont) en 503, jamais en 400 accusant la photo", async () => {
        // 429 signale un quota Gemini épuisé en amont — une panne de
        // capacité, pas une photo en cause. Le compter en 400 la ferait
        // porter au marchand et la rendrait invisible en supervision.
        const marchand = await inscrire(api, "etal-cat-429", "22990009011")

        const vision = await servirVisionFactice({ statutDetect: 429 })
        let reponse: any
        try {
          reponse = await api
            .post("/merchant/catalogues", corpsPhoto("Étal quota épuisé"), {
              headers: { authorization: `Bearer ${marchand.jeton}` },
            })
            .catch((e: any) => e.response)
        } finally {
          await vision.fermer()
        }

        expect(reponse.status).toBe(503)
        expect(reponse.data.message).toMatch(/indisponible/i)
        expect(reponse.data.message).not.toContain("(429)")
      })
    })
  },
})
