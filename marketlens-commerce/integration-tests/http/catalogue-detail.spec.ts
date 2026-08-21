import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { servirVisionFactice } from "./helpers/vision-stub"

jest.setTimeout(90 * 1000)

const ZONE_TOMATES = { label: "Tomates", x: 250, y: 400, width: 200, height: 150, category: "fruits_legumes" }

/** Corps multipart d'une photo d'étal minimale (quatre octets d'en-tête
 *  JPEG) : ce fichier n'éprouve jamais le décodage de l'image, seulement le
 *  détail rendu par la route. Copié de catalogue-store.spec.ts : le brief
 *  demande de s'en inspirer plutôt que d'y créer une dépendance inter-
 *  fichiers, la base de test étant partagée mais chaque fichier isolé. */
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
 *  serveur de vision factice, fermé avant de retourner. */
async function inscrireEtAnalyser(api: any, handle: string, phone: string) {
  const email = `${handle}@marketlens.test`
  const inscription = await api.post("/auth/merchant/emailpass/register", {
    email,
    password: "motdepasse-de-test",
  })
  await api.post(
    "/merchant/register",
    { name: `Étal ${handle}`, handle, phone },
    { headers: { authorization: `Bearer ${inscription.data.token}` } }
  )
  const connexion = await api.post("/auth/merchant/emailpass", {
    email,
    password: "motdepasse-de-test",
  })
  const jeton = connexion.data.token

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
      catalogueId: reponse.data.catalogue.id,
      catalogueHandle: reponse.data.catalogue.handle,
      zones: reponse.data.zones,
    }
  } finally {
    await vision.fermer()
  }
}

medusaIntegrationTestRunner({
  testSuite: ({ api }) => {
    describe("GET /merchant/catalogues/:id — détail d'un catalogue", () => {
      it("rend le détail avec ses zones, et refuse le catalogue d'un autre marchand", async () => {
        const yaa = await inscrireEtAnalyser(api, "etal-detail-yaa", "22990000071")
        const kwame = await inscrireEtAnalyser(api, "etal-detail-kwame", "22990000072")

        const detail = await api.get(`/merchant/catalogues/${yaa.catalogueId}`, {
          headers: { authorization: `Bearer ${yaa.jeton}` },
        })
        expect(detail.status).toBe(200)
        expect(detail.data.catalogue.id).toBe(yaa.catalogueId)
        expect(detail.data.catalogue.handle).toBe(yaa.catalogueHandle)
        expect(detail.data.catalogue.status).toBe("draft")
        expect(detail.data.catalogue.source_image_url).toBeTruthy()
        expect(detail.data.catalogue.annotated_image_url).toBeNull()
        expect(detail.data.catalogue.zones.length).toBeGreaterThan(0)
        expect(detail.data.catalogue.zones[0].detected_label).toBeTruthy()
        expect(typeof detail.data.catalogue.zones[0].x).toBe("number")
        expect(typeof detail.data.catalogue.zones[0].y).toBe("number")
        expect(typeof detail.data.catalogue.zones[0].width).toBe("number")
        expect(typeof detail.data.catalogue.zones[0].height).toBe("number")
        // Un brouillon n'a pas encore de produit : le champ existe et vaut null.
        expect(detail.data.catalogue.zones[0].product).toBeNull()

        // Le catalogue d'autrui est INTROUVABLE, pas interdit : un 403 confirmerait
        // son existence à qui ne devrait pas la connaître.
        const vol = await api
          .get(`/merchant/catalogues/${yaa.catalogueId}`, {
            headers: { authorization: `Bearer ${kwame.jeton}` },
          })
          .catch((e: any) => e.response)
        expect(vol.status).toBe(404)
      })

      it("rend 404, jamais 403, pour un catalogue qui n'existe pas du tout", async () => {
        const marchand = await inscrireEtAnalyser(api, "etal-detail-inconnu", "22990000073")

        const reponse = await api
          .get(`/merchant/catalogues/cat_inexistant_${Date.now()}`, {
            headers: { authorization: `Bearer ${marchand.jeton}` },
          })
          .catch((e: any) => e.response)
        expect(reponse.status).toBe(404)
      })

      it("refuse sans jeton", async () => {
        const reponse = await api
          .get(`/merchant/catalogues/cat_peu_importe`)
          .catch((e: any) => e.response)
        expect(reponse.status).toBe(401)
      })

      it("après publication, la zone tarifée porte son produit avec titre, variantes et prix XOF", async () => {
        const marchand = await inscrireEtAnalyser(api, "etal-detail-publie", "22990000074")

        const vision = await servirVisionFactice({
          detect: { products: [ZONE_TOMATES], count: 1 },
        })
        try {
          const publication = await api.post(
            `/merchant/catalogues/${marchand.catalogueId}/publish`,
            {
              items: [
                {
                  zone_id: marchand.zones[0].id,
                  label: "Tomates fraîches du détail",
                  price: "500",
                  quantity: 3,
                  colors: [],
                  sizes: [],
                },
              ],
            },
            { headers: { authorization: `Bearer ${marchand.jeton}` } }
          )
          expect(publication.status).toBe(200)
        } finally {
          await vision.fermer()
        }

        const detail = await api.get(`/merchant/catalogues/${marchand.catalogueId}`, {
          headers: { authorization: `Bearer ${marchand.jeton}` },
        })
        expect(detail.status).toBe(200)
        expect(detail.data.catalogue.status).toBe("published")
        expect(detail.data.catalogue.annotated_image_url).toBeTruthy()

        const zone = detail.data.catalogue.zones.find((z: any) => z.product !== null)
        expect(zone).toBeTruthy()
        expect(zone.product.title).toBe("Tomates fraîches du détail")
        expect(zone.product.variants.length).toBeGreaterThanOrEqual(1)
        expect(zone.product.variants[0].prix).toBe(500)
        // Le libellé détecté par la vision et le titre du produit divergent
        // par construction : les deux champs coexistent, chacun avec son sens.
        expect(zone.detected_label).not.toBe(zone.product.title)
      })
    })
  },
})
