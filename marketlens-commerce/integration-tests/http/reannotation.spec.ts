import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { VISUAL_CATALOG_MODULE } from "../../src/modules/visual-catalog"
import { servirVisionFactice } from "./helpers/vision-stub"

jest.setTimeout(90 * 1000)

const MOT_DE_PASSE = "motdepasse-de-test"

const ZONE_PAGNE = { label: "Pagne", x: 250, y: 400, width: 200, height: 150, category: "textile" }
const ZONE_TOMATES = { label: "Tomates", x: 700, y: 500, width: 250, height: 300, category: "fruits_legumes" }

/** Corps multipart d'une photo d'étal minimale (quatre octets d'en-tête
 *  JPEG), sur le même motif que catalogue-detail.spec.ts : ce fichier
 *  n'éprouve jamais le décodage de l'image, seulement les routes. */
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

type CatalogueDeTest = {
  jeton: string
  catalogueId: string
  zones: { id: string; detected_label: string }[]
}

/**
 * Inscrit une commerçante, analyse une photo pour elle puis PUBLIE le
 * catalogue — deux zones, deux produits. Tout passe par les vraies routes
 * HTTP : c'est le seul moyen de prouver que `source_image_id` est bien
 * persisté par le chemin réel, et non seulement par un appel direct au
 * workflow.
 */
async function publierUnCatalogue(
  api: any,
  handle: string,
  phone: string
): Promise<CatalogueDeTest> {
  const email = `${handle}@marketlens.test`
  const inscription = await api.post("/auth/merchant/emailpass/register", {
    email,
    password: MOT_DE_PASSE,
  })
  await api.post(
    "/merchant/register",
    { name: `Étal ${handle}`, handle, phone },
    { headers: { authorization: `Bearer ${inscription.data.token}` } }
  )
  // Second jeton : celui de l'inscription ne porte pas encore d'`actor_id`.
  const connexion = await api.post("/auth/merchant/emailpass", {
    email,
    password: MOT_DE_PASSE,
  })
  const jeton = connexion.data.token as string

  const vision = await servirVisionFactice({
    detect: { products: [ZONE_PAGNE, ZONE_TOMATES], count: 2 },
  })
  try {
    const analyse = await api.post(
      "/merchant/catalogues",
      corpsPhoto(`Catalogue de ${handle}`),
      { headers: { authorization: `Bearer ${jeton}` } }
    )
    const catalogueId = analyse.data.catalogue.id as string
    const zones = analyse.data.zones as { id: string; detected_label: string }[]

    const publication = await api.post(
      `/merchant/catalogues/${catalogueId}/publish`,
      {
        items: [
          { zone_id: zones[0].id, label: "Pagne wax", price: "5000", quantity: 3, colors: [], sizes: [] },
          { zone_id: zones[1].id, label: "Tomates fraîches", price: "500", quantity: 10, colors: [], sizes: [] },
        ],
      },
      { headers: { authorization: `Bearer ${jeton}` } }
    )
    expect(publication.status).toBe(200)

    return { jeton, catalogueId, zones }
  } finally {
    await vision.fermer()
  }
}

async function detailCatalogue(api: any, m: CatalogueDeTest) {
  const reponse = await api.get(`/merchant/catalogues/${m.catalogueId}`, {
    headers: { authorization: `Bearer ${m.jeton}` },
  })
  return reponse.data.catalogue
}

async function urlAnnotee(api: any, m: CatalogueDeTest): Promise<string> {
  return (await detailCatalogue(api, m)).annotated_image_url
}

/** Prix XOF posé sur la première variante du produit d'UNE zone donnée.
 *  La zone est retrouvée par identifiant, jamais par position : l'ordre des
 *  zones rendues par `query.graph` n'est garanti nulle part. */
async function prixDeLaZone(
  api: any,
  m: CatalogueDeTest,
  zoneId: string
): Promise<number | null> {
  const catalogue = await detailCatalogue(api, m)
  const zone = catalogue.zones.find((z: any) => z.id === zoneId)
  return zone?.product?.variants?.[0]?.prix ?? null
}

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("PATCH /merchant/catalogues/:id/items — correction des prix et réannotation", () => {
      it("régénère l'image annotée sans repasser par la détection", async () => {
        const m = await publierUnCatalogue(api, "etal-reannote", "22990000101")
        const avant = await urlAnnotee(api, m)
        expect(avant).toBeTruthy()

        // Le serveur de vision ne répond plus QUE sur /annotate : si la
        // régénération repassait par /detect, ce test échouerait — c'est le
        // point.
        const vision = await servirVisionFactice({ annotateSeulement: true })
        try {
          const r = await api.patch(
            `/merchant/catalogues/${m.catalogueId}/items`,
            { items: [{ zone_id: m.zones[0].id, price: "2500", quantity: 7 }] },
            { headers: { authorization: `Bearer ${m.jeton}` } }
          )
          expect(r.status).toBe(200)
          expect(r.data.avertissement).toBeUndefined()
        } finally {
          await vision.fermer()
        }

        expect(await urlAnnotee(api, m)).not.toBe(avant)
        expect(await prixDeLaZone(api, m, m.zones[0].id)).toBe(2500)
        // La zone non corrigée garde son prix : la correction ne touche que
        // les articles envoyés.
        expect(await prixDeLaZone(api, m, m.zones[1].id)).toBe(500)
      })

      it("refuse en français quand l'image source n'est plus disponible", async () => {
        const m = await publierUnCatalogue(api, "etal-source-perdue", "22990000102")
        // Simule un catalogue d'avant la migration : identifiant source absent.
        const service: any = getContainer().resolve(VISUAL_CATALOG_MODULE)
        await service.updateVisualCatalogues({
          id: m.catalogueId,
          source_image_id: null,
        })

        const r = await api
          .patch(
            `/merchant/catalogues/${m.catalogueId}/items`,
            { items: [{ zone_id: m.zones[0].id, price: "3000", quantity: 1 }] },
            { headers: { authorization: `Bearer ${m.jeton}` } }
          )
          .catch((e: any) => e.response)

        // Le prix EST à jour ; c'est seulement l'image qui n'a pas suivi.
        // Laisser croire que rien n'a changé serait le pire comportement.
        expect(r.status).toBe(200)
        expect(r.data.avertissement).toContain("image")
        expect(await prixDeLaZone(api, m, m.zones[0].id)).toBe(3000)
      })

      it("refuse en français une quantité invalide, sans toucher au prix", async () => {
        const m = await publierUnCatalogue(api, "etal-corr-invalide", "22990000103")
        const avant = await urlAnnotee(api, m)

        const r = await api
          .patch(
            `/merchant/catalogues/${m.catalogueId}/items`,
            { items: [{ zone_id: m.zones[0].id, price: "2500", quantity: -1 }] },
            { headers: { authorization: `Bearer ${m.jeton}` } }
          )
          .catch((e: any) => e.response)

        expect(r.status).toBe(400)
        expect(r.data.message).toContain("entier positif ou nul")
        expect(await prixDeLaZone(api, m, m.zones[0].id)).toBe(5000)
        expect(await urlAnnotee(api, m)).toBe(avant)
      })

      it("rend 404, jamais 403, sur le catalogue d'une autre commerçante", async () => {
        const yaa = await publierUnCatalogue(api, "etal-corr-yaa", "22990000104")
        const kwame = await publierUnCatalogue(api, "etal-corr-kwame", "22990000105")

        const r = await api
          .patch(
            `/merchant/catalogues/${yaa.catalogueId}/items`,
            { items: [{ zone_id: yaa.zones[0].id, price: "9999", quantity: 1 }] },
            { headers: { authorization: `Bearer ${kwame.jeton}` } }
          )
          .catch((e: any) => e.response)

        expect(r.status).toBe(404)
        expect(await prixDeLaZone(api, yaa, yaa.zones[0].id)).toBe(5000)
      })
    })
  },
})
