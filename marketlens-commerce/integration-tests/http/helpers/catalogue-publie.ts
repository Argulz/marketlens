import { servirVisionFactice } from "./vision-stub"

/**
 * Montage d'un catalogue PUBLIÉ par les vraies routes HTTP, partagé entre les
 * fichiers de test qui en ont besoin.
 *
 * Extrait de `reannotation.spec.ts` (où il était défini) plutôt que recopié
 * dans `depublication.spec.ts` : c'est la même séquence exacte — inscription,
 * analyse d'une photo, publication — et deux copies divergeraient à la
 * première évolution de l'une des trois routes traversées. Le corollaire de
 * l'extraction de `produitsAAnnoter` côté production.
 */

const MOT_DE_PASSE = "motdepasse-de-test"

export const ZONE_PAGNE = {
  label: "Pagne", x: 250, y: 400, width: 200, height: 150, category: "textile",
}
export const ZONE_TOMATES = {
  label: "Tomates", x: 700, y: 500, width: 250, height: 300, category: "fruits_legumes",
}

/** Corps multipart d'une photo d'étal minimale (quatre octets d'en-tête
 *  JPEG), sur le même motif que catalogue-detail.spec.ts : les fichiers qui
 *  s'en servent n'éprouvent jamais le décodage de l'image, seulement les
 *  routes. */
export function corpsPhoto(titre: string): FormData {
  const form = new FormData()
  form.append(
    "image",
    new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" }),
    "etal.jpg"
  )
  form.append("title", titre)
  return form
}

export type CatalogueDeTest = {
  jeton: string
  catalogueId: string
  /** Handle du CATALOGUE (`cat-xxxxxxxx`), pas celui du marchand : c'est lui
   *  qui adresse la vitrine publique `/c/<handle>`. */
  handle: string
  zones: { id: string; detected_label: string }[]
}

/**
 * Inscrit une commerçante, analyse une photo pour elle puis PUBLIE le
 * catalogue — deux zones, deux produits. Tout passe par les vraies routes
 * HTTP : c'est le seul moyen de prouver que `source_image_id` est bien
 * persisté par le chemin réel, et non seulement par un appel direct au
 * workflow.
 */
export async function publierUnCatalogue(
  api: any,
  handle: string,
  phone: string,
  // Nombre de zones réellement MISES EN VENTE. Deux par défaut ; une seule
  // laisse la seconde zone détectée sans aucun produit — l'état qu'une
  // commerçante obtient dès qu'elle ne tarife pas tout son étal, et que
  // l'écran de correction affichera pourtant en ligne.
  zonesAPublier: 1 | 2 = 2
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
    const catalogueHandle = analyse.data.catalogue.handle as string
    const zones = analyse.data.zones as { id: string; detected_label: string }[]

    const publication = await api.post(
      `/merchant/catalogues/${catalogueId}/publish`,
      {
        items: [
          { zone_id: zones[0].id, label: "Pagne wax", price: "5000", quantity: 3, colors: [], sizes: [] },
          { zone_id: zones[1].id, label: "Tomates fraîches", price: "500", quantity: 10, colors: [], sizes: [] },
        ].slice(0, zonesAPublier),
      },
      { headers: { authorization: `Bearer ${jeton}` } }
    )
    expect(publication.status).toBe(200)

    return { jeton, catalogueId, handle: catalogueHandle, zones }
  } finally {
    await vision.fermer()
  }
}
