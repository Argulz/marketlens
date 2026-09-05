import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
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
 * Inscrit une commerçante et analyse une photo pour elle, SANS publier : le
 * catalogue reste `draft` et ne porte aucun produit.
 *
 * C'est l'état d'un catalogue JAMAIS publié — à ne pas confondre avec celui
 * d'un catalogue dépublié, qui est `draft` lui aussi mais garde tous ses
 * produits. Les routes qui distinguent les deux (correction des prix, remise
 * en ligne) ne peuvent être éprouvées que si le montage sait produire l'un
 * comme l'autre.
 */
export async function analyserUnCatalogue(
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
    return {
      jeton,
      catalogueId: analyse.data.catalogue.id as string,
      handle: analyse.data.catalogue.handle as string,
      zones: analyse.data.zones as { id: string; detected_label: string }[],
    }
  } finally {
    await vision.fermer()
  }
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
  const m = await analyserUnCatalogue(api, handle, phone)

  // La publication redessine l'image annotée : elle a besoin d'un service de
  // vision, mais jamais de la DÉTECTION, déjà faite par l'analyse.
  const vision = await servirVisionFactice({ annotateSeulement: true })
  try {
    const publication = await api.post(
      `/merchant/catalogues/${m.catalogueId}/publish`,
      {
        items: [
          { zone_id: m.zones[0].id, label: "Pagne wax", price: "5000", quantity: 3, colors: [], sizes: [] },
          { zone_id: m.zones[1].id, label: "Tomates fraîches", price: "500", quantity: 10, colors: [], sizes: [] },
        ].slice(0, zonesAPublier),
      },
      { headers: { authorization: `Bearer ${m.jeton}` } }
    )
    expect(publication.status).toBe(200)
  } finally {
    await vision.fermer()
  }

  return m
}

/** Détail du catalogue tel que la commerçante le voit. Partagé : plusieurs
 *  fichiers lisent le statut, l'URL annotée ou les prix par ce chemin, et
 *  chacun refaisait le même GET. */
export async function detailCatalogue(api: any, m: CatalogueDeTest): Promise<any> {
  const reponse = await api.get(`/merchant/catalogues/${m.catalogueId}`, {
    headers: { authorization: `Bearer ${m.jeton}` },
  })
  return reponse.data.catalogue
}

/**
 * Tous les prix XOF posés sur les variantes du produit d'une zone, et les
 * quantités en stock de leurs articles d'inventaire. Lecture directe, sans
 * passer par la route : c'est la seule façon de voir qu'une correction
 * REMPLACE le prix au lieu d'en empiler un second (le détail rendu par la
 * route ne montre que le premier prix XOF trouvé, donc un doublon y
 * resterait invisible), et la seule façon de voir qu'un cycle
 * dépublier / republier n'a touché ni au stock ni aux prix.
 */
export async function etatCommercial(
  api: any,
  getContainer: any,
  m: CatalogueDeTest,
  zoneId: string
): Promise<{ prixXof: number[]; quantites: number[] }> {
  const catalogue = await detailCatalogue(api, m)
  const zone = catalogue.zones.find((z: any) => z.id === zoneId)
  const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)

  const { data: produits } = await query.graph({
    entity: "product",
    fields: [
      "id",
      "variants.id",
      "variants.prices.amount",
      "variants.prices.currency_code",
      "variants.inventory_items.inventory_item_id",
    ],
    filters: { id: [zone.product.id] },
  })

  const prixXof: number[] = []
  const idsInventaire: string[] = []
  for (const variante of (produits[0] as any).variants ?? []) {
    for (const prix of variante.prices ?? []) {
      if (prix.currency_code === "xof") prixXof.push(prix.amount)
    }
    for (const article of (variante.inventory_items ?? []).filter(Boolean)) {
      idsInventaire.push(article.inventory_item_id)
    }
  }

  const { data: niveaux } = await query.graph({
    entity: "inventory_level",
    fields: ["inventory_item_id", "stocked_quantity"],
    filters: { inventory_item_id: idsInventaire },
  })

  return {
    prixXof,
    quantites: (niveaux as any[]).map((n) => Number(n.stocked_quantity)),
  }
}
