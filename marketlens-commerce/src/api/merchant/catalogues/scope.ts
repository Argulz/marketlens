import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import { MERCHANT_MODULE } from "../../../modules/merchant"
import MerchantModuleService from "../../../modules/merchant/service"
import { ProduitAnnote } from "../../../lib/vision-client"

/** Seul statut qui autorise quoi que ce soit. Exporté parce que la route de
 *  vitrine (`/store/catalogues/[handle]`) applique la MÊME règle sur le
 *  marchand remonté par le lien, avec une réponse différente (404 et non
 *  403) : la règle est partagée, la traduction en réponse HTTP ne l'est
 *  pas. */
export const STATUT_MARCHAND_ACTIF = "active"

export function marchandEstActif(statut: string | undefined | null): boolean {
  return statut === STATUT_MARCHAND_ACTIF
}

// Même message pour les deux branches d'échec d'identité : dans les deux
// cas, le jeton ne correspond plus à un marchand. `actor_id` ne vient jamais
// du client (il est posé par setAuthAppMetadataStep à l'inscription), donc un
// marchand introuvable ne peut résulter que d'un rattachement devenu invalide
// (marchand supprimé) — pas d'une ressource que le client aurait mal
// identifiée. Traiter ce cas comme un problème d'identité (401) plutôt que
// comme une ressource absente (404) garde un contrat d'erreur unique, et
// évite de calquer le message anglais du dépôt Medusa (`Merchant with id:
// <id> was not found`).
//
// Le message est unique côté client, mais les deux branches se distinguent
// dans les journaux : un jeton sans actor_id est une configuration
// d'authentification incomplète, tandis qu'un actor_id qui ne résout plus est
// un marchand disparu sous une identité toujours vivante — un incident, pas
// une erreur d'appelant.
export const MESSAGE_IDENTITE_NON_RATTACHEE = "Identité non rattachée à un marchand"

/** Exporté parce que la garde des PAGES du back-office
 *  (`src/api/marchand/garde.ts`) rend ce type. Le recopier là-bas
 *  divergerait en silence à la première migration du module marchand : il est
 *  dérivé de la signature du service, pas écrit à la main. */
export type Marchand = Awaited<ReturnType<MerchantModuleService["retrieveMerchant"]>>

export type ControleMarchand =
  | { autorise: true; marchand: Marchand }
  | { autorise: false; statut: 401 | 403; message: string }

/**
 * Étiquette de journal d'une route marchand : le nom de la route ET
 * l'identité d'authentification appelante. Les deux sont nécessaires au
 * diagnostic — un refus 401 sur un `actor_id` orphelin est un incident
 * (marchand disparu sous une identité toujours vivante), et sans
 * `auth_identity_id` on ne peut pas remonter à l'identité concernée. Cette
 * étiquette ne quitte JAMAIS le serveur : elle ne va que dans les journaux.
 */
export function etiquetteJournal(
  req: { auth_context: { auth_identity_id?: string } },
  route: string
): string {
  return `${route} (auth_identity_id=${req.auth_context.auth_identity_id})`
}

/**
 * Le SEUL point de décision « ce jeton porte-t-il un marchand qui a le droit
 * d'agir ? ». Trois refus possibles, dans cet ordre :
 *
 *  - jeton authentifié sans `actor_id` → 401 (identité jamais rattachée) ;
 *  - `actor_id` qui ne résout plus aucun marchand → 401 (rattachement
 *    orphelin : marchand supprimé sous une identité toujours vivante). Sans
 *    ce contrôle, la liste des catalogues rendait `200 []` — indiscernable
 *    d'un marchand actif sans catalogue — et le POST créait un catalogue
 *    rattaché à un marchand inexistant ;
 *  - statut différent d'`active` → 403 français. `status` n'est pas
 *    décoratif : un marchand `pending` (jamais provisionné) ou `suspended`
 *    (coupé par l'opérateur) porte une identité valide mais ne doit rien
 *    pouvoir faire. Sans cette lecture sur CHAQUE route, une suspension
 *    n'aurait aucun effet observable — le marchand suspendu continuerait de
 *    téléverser des photos, de créer de vrais produits dans son canal et de
 *    poser du stock.
 *
 * `merchantId` vient toujours de `req.auth_context.actor_id`, jamais du corps
 * ni de l'URL. `etiquette` ne sert qu'aux journaux (jamais au client) : elle
 * nomme la route appelante pour qu'un refus reste diagnosticable.
 */
export async function marchandActifOuRefus(
  container: MedusaContainer,
  merchantId: string | undefined,
  etiquette: string
): Promise<ControleMarchand> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  if (!merchantId) {
    logger.warn(
      `${etiquette} : jeton authentifié sans actor_id — identité jamais rattachée à un marchand.`
    )
    return { autorise: false, statut: 401, message: MESSAGE_IDENTITE_NON_RATTACHEE }
  }

  const service = container.resolve<MerchantModuleService>(MERCHANT_MODULE)

  let marchand: Marchand
  try {
    marchand = await service.retrieveMerchant(merchantId)
  } catch (e) {
    if (e instanceof MedusaError && e.type === MedusaError.Types.NOT_FOUND) {
      logger.warn(
        `${etiquette} : actor_id=${merchantId} ne résout aucun marchand — rattachement orphelin.`
      )
      return { autorise: false, statut: 401, message: MESSAGE_IDENTITE_NON_RATTACHEE }
    }
    throw e
  }

  if (!marchandEstActif(marchand.status)) {
    logger.warn(
      `${etiquette} : marchand ${merchantId} refusé, statut « ${marchand.status} ».`
    )
    return {
      autorise: false,
      statut: 403,
      message: `Compte marchand inactif (statut : ${marchand.status})`,
    }
  }

  return { autorise: true, marchand }
}

export type CatalogueDuMarchand = {
  id: string
  handle: string
  title: string
  status: string
  source_image_url: string
  // Clé de fichier de la photo d'origine, seule valeur que
  // `getAsBuffer` accepte. `null` pour les catalogues créés avant la
  // colonne : leur image annotée n'est plus régénérable, ce que les
  // appelants traduisent en message français plutôt qu'en panne.
  source_image_id: string | null
  annotated_image_url: string | null
}

/**
 * Rend les catalogues du marchand porté par le jeton, et rien d'autre.
 * `merchantId` vient toujours de `req.auth_context.actor_id`, jamais du
 * corps ni de l'URL : c'est ce qui rend le cloisonnement structurel. Cet
 * assistant est le SEUL endroit qui décide qui voit quoi — les trois routes
 * marchand de ce module l'appellent plutôt que de refaire ce filtrage
 * chacune à sa façon.
 */
export async function cataloguesDuMarchand(
  container: MedusaContainer,
  merchantId: string
): Promise<CatalogueDuMarchand[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "merchant",
    fields: ["id", "visual_catalogues.*"],
    filters: { id: merchantId },
  })
  const marchand = data[0] as unknown as
    | { id: string; visual_catalogues: CatalogueDuMarchand[] }
    | undefined
  return marchand?.visual_catalogues ?? []
}

/** `null` si le catalogue n'existe pas OU n'appartient pas à ce marchand :
 *  les deux cas doivent être indiscernables pour l'appelant — un 403 sur un
 *  catalogue d'autrui confirmerait son existence à qui ne devrait pas la
 *  connaître. */
export async function catalogueDuMarchand(
  container: MedusaContainer,
  merchantId: string,
  catalogueId: string
): Promise<CatalogueDuMarchand | null> {
  const catalogues = await cataloguesDuMarchand(container, merchantId)
  return catalogues.find((c) => c.id === catalogueId) ?? null
}

export type ZoneDetail = {
  id: string
  x: number
  y: number
  width: number
  height: number
  detected_label: string
  detected_category: string | null
  product: {
    id: string
    title: string
    variants: { id: string; title: string; prix: number | null }[]
  } | null
}

export type DetailCatalogue = {
  id: string
  handle: string
  title: string
  status: string
  source_image_url: string
  source_image_id: string | null
  annotated_image_url: string | null
  zones: ZoneDetail[]
}

/** Lecture directe du prix posé sur la variante, sans passer par le prix
 *  CALCULÉ (celui qui tiendrait compte d'une région, d'une liste de prix
 *  promotionnelle, etc.). Limite assumée et documentée dans la spec : ça
 *  tient tant qu'il n'existe qu'une devise et aucune liste de prix. Le jour
 *  où une promotion ou une deuxième devise apparaît, cette lecture posée
 *  devient fausse et il faudra passer par le prix calculé avec un contexte
 *  de région — pas rajouter un filtre de plus ici. */
function prixXof(
  prix: { amount: number; currency_code: string }[] | undefined
): number | null {
  return prix?.find((p) => p.currency_code === "xof")?.amount ?? null
}

/**
 * Détail complet d'UN catalogue du marchand porté par le jeton, zones et
 * produits liés compris. Le contrôle d'appartenance passe entièrement par
 * `catalogueDuMarchand` : c'est le seul endroit qui décide qui voit quoi, et
 * il rend `null` aussi bien pour un catalogue inexistant que pour celui d'un
 * autre marchand — les deux cas restent indiscernables jusqu'ici.
 */
export async function detailCatalogueDuMarchand(
  container: MedusaContainer,
  merchantId: string,
  catalogueId: string
): Promise<DetailCatalogue | null> {
  const possede = await catalogueDuMarchand(container, merchantId, catalogueId)
  if (!possede) return null

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "visual_catalogue",
    fields: [
      "id",
      "handle",
      "title",
      "status",
      "source_image_url",
      "source_image_id",
      "annotated_image_url",
      "zones.id",
      "zones.x",
      "zones.y",
      "zones.width",
      "zones.height",
      "zones.detected_label",
      "zones.detected_category",
      // Champ SINGULIER (`product`, pas `products`) : une zone porte au plus
      // un produit publié. Le pluriel est accepté sans erreur par
      // query.graph et ne renvoie simplement rien — piège vérifié sur cette
      // base, voir le même avertissement sur le lien marchand→catalogue.
      "zones.product.id",
      "zones.product.title",
      "zones.product.variants.id",
      "zones.product.variants.title",
      "zones.product.variants.prices.amount",
      "zones.product.variants.prices.currency_code",
    ],
    filters: { id: catalogueId },
  })

  const c = data[0] as any
  if (!c) return null

  return {
    id: c.id,
    handle: c.handle,
    title: c.title,
    status: c.status,
    source_image_url: c.source_image_url,
    source_image_id: c.source_image_id ?? null,
    annotated_image_url: c.annotated_image_url ?? null,
    zones: (c.zones ?? []).map((z: any) => ({
      id: z.id,
      x: z.x,
      y: z.y,
      width: z.width,
      height: z.height,
      detected_label: z.detected_label,
      // `null`, jamais absent : une zone peut ne porter aucune catégorie
      // détectée, tout comme elle peut ne porter aucun produit.
      detected_category: z.detected_category ?? null,
      product: z.product
        ? {
            id: z.product.id,
            title: z.product.title,
            variants: (z.product.variants ?? []).map((v: any) => ({
              id: v.id,
              title: v.title,
              prix: prixXof(v.prices),
            })),
          }
        : null,
    })),
  }
}

/** Prix XOF actuellement posé sur la première variante d'une zone. Sert à
 *  redessiner l'image entière : les zones NON corrigées doivent y garder
 *  leur prix, sans quoi la nouvelle image mentirait sur elles. */
export function prixAffiche(zone: ZoneDetail): string {
  return String(zone.product?.variants?.[0]?.prix ?? "")
}

/**
 * Projection `DetailCatalogue → ProduitAnnote[]` : ce que le service de
 * vision doit dessiner sur l'image d'un catalogue publié.
 *
 * Exportée depuis ce fichier, et non gardée privée dans la route de
 * correction des prix, parce qu'elle TRANCHE deux contraintes globales du
 * lot, et qu'une seconde copie les re-trancherait en silence :
 *
 *  - les zones sans produit publié sont filtrées (une zone peut ne porter
 *    aucun produit : la commerçante ne l'a pas mise en vente) ;
 *  - le libellé montré est celui du PRODUIT publié, jamais
 *    `detected_label` : les deux divergent par construction (elle a pu
 *    corriger « pagne » en « Pagne wax »), et c'est le sien qui fait foi.
 */
export function produitsAAnnoter(detail: DetailCatalogue): ProduitAnnote[] {
  return detail.zones
    .filter((zone) => zone.product)
    .map((zone) => ({
      label: zone.product!.title,
      x: zone.x,
      y: zone.y,
      width: zone.width,
      height: zone.height,
      // Une zone peut ne porter aucune catégorie détectée : le service de
      // vision accepte une chaîne vide, pas un `null`.
      category: zone.detected_category ?? "",
      price: prixAffiche(zone),
    }))
}
