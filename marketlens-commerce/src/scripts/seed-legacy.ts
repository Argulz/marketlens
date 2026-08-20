import fs from "fs"
import path from "path"
import http from "http"
import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import createMerchantWorkflow from "../workflows/create-merchant"
import analyzeCataloguePhotoWorkflow from "../workflows/analyze-catalogue-photo"
import publishCatalogueWorkflow from "../workflows/publish-catalogue"
import { assurerRegionXof } from "../workflows/ensure-region"

type ProduitLegacy = {
  label: string
  x: number
  y: number
  width: number
  height: number
  category: string
  description?: string
  price?: string
  colors?: string[]
  sizes?: string[]
  // Rencontré dans l'archive (catalogue 0e61cd9284) sans jamais être
  // consommé par publishCatalogueWorkflow, qui ne connaît que `colors` et
  // `sizes`. On le type ici pour pouvoir le DÉTECTER et le SIGNALER — voir
  // la section « pertes de représentation » plus bas — pas pour lui
  // inventer une correspondance vers les options Medusa : cette
  // correspondance est une vraie question de modélisation, hors du
  // périmètre de cette tâche d'import.
  options?: unknown
}

type MetadataLegacy = {
  id: string
  products: ProduitLegacy[]
  merchant_name?: string
  merchant_phone?: string
  merchant_whatsapp?: string
  created_at?: number
}

// L'archive n'est pas versionnée avec ce dépôt (elle vit hors du monorepo) ;
// ces deux constantes sont le seul filet contre une archive partielle ou mal
// pointée — mieux vaut arrêter tout net que d'importer un sous-ensemble en
// silence et prétendre avoir validé le modèle sur 28 catalogues.
const NOMBRE_CATALOGUES_ATTENDU = 28
// Ce catalogue n'a jamais été suivi par git : il n'existe que dans
// l'archive. S'il manque, l'archive elle-même est incomplète.
const CATALOGUE_TEMOIN = "a63c379117"

function slug(brut: string): string {
  return (
    brut
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "marchand"
  )
}

type EtatVisionFactice = { produits: ProduitLegacy[] }

/**
 * Remplace le service de vision par un serveur HTTP local éphémère qui
 * rejoue les produits du `metadata.json` du catalogue en cours d'import
 * (posés dans `etat` juste avant chaque appel) au lieu d'appeler Gemini.
 * Aucun appel réseau externe : ce script exerce le vrai chemin
 * `analyzeCataloguePhotoWorkflow` / `publishCatalogueWorkflow` de bout en
 * bout, sans contourner d'étape de workflow ni de contrat public.
 *
 * Même mécanisme que `integration-tests/http/helpers/vision-stub.ts`, à un
 * détail près : ce script a besoin de faire varier la réponse `/detect`
 * catalogue par catalogue au sein d'un même processus, ce que le stub de
 * test (réponses figées à la construction) ne permet pas.
 */
function demarrerServeurVisionFactice(etat: EtatVisionFactice, secret: string) {
  return http.createServer((req, res) => {
    if (req.headers["x-vision-secret"] !== secret) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ message: "secret invalide" }))
      req.resume()
      return
    }
    // La réponse ne dépend que de l'état du catalogue en cours (`etat`),
    // jamais du corps envoyé : on le draine sans le parser.
    req.resume()
    req.on("end", () => {
      if (req.url?.startsWith("/detect")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            products: etat.produits.map((p) => ({
              label: p.label,
              x: p.x,
              y: p.y,
              width: p.width,
              height: p.height,
              category: p.category,
            })),
          })
        )
        return
      }
      // /annotate : le contenu de l'image renvoyée n'a aucune importance
      // pour cette preuve — seul compte que le workflow reçoive des octets
      // JPEG valides à uploader. On renvoie un JPEG minimal.
      res.writeHead(200, { "content-type": "image/jpeg" })
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]))
    })
  })
}

type CatalogueLegacy = { dossier: string; meta: MetadataLegacy }

type GroupePhone = {
  telephone: string
  // Un groupe est « fabriqué » quand AUCUN catalogue du groupe ne porte de
  // merchant_phone dans l'archive : le téléphone est alors une valeur
  // synthétique (`inconnu-<dossier>`) que ce script invente pour donner
  // au marchand une identité minimale exploitable — jamais une identité
  // recopiée d'une autre source.
  fabrique: boolean
  dossiers: string[]
  // nom / whatsapp -> dossiers qui portent CETTE valeur (uniquement les
  // valeurs non vides). Sert à détecter les divergences intra-marchand :
  // le même téléphone, mais des valeurs différentes selon le catalogue.
  noms: Map<string, string[]>
  whatsapps: Map<string, string[]>
}

/**
 * Analyse l'archive SANS écrire quoi que ce soit : regroupe les 28
 * catalogues par identité marchande (téléphone réel ou fabriqué) et
 * détecte, pour chaque groupe, les valeurs de `merchant_name` /
 * `merchant_whatsapp` qui divergent entre catalogues d'un même marchand.
 * La valeur retenue est toujours celle du premier dossier du groupe dans
 * l'ordre trié — c'est exactement celle que la boucle d'import plus bas
 * utilisera pour créer le marchand (premier catalogue rencontré pour ce
 * téléphone), donc ce qui est « rejeté » ici est réellement perdu par
 * l'import, pas une approximation.
 */
function analyserIdentitesMarchandes(catalogues: CatalogueLegacy[]): Map<string, GroupePhone> {
  const groupes = new Map<string, GroupePhone>()
  for (const { dossier, meta } of catalogues) {
    const fabrique = !meta.merchant_phone
    const telephone = meta.merchant_phone || `inconnu-${dossier}`
    if (!groupes.has(telephone)) {
      groupes.set(telephone, { telephone, fabrique, dossiers: [], noms: new Map(), whatsapps: new Map() })
    }
    const g = groupes.get(telephone)!
    g.dossiers.push(dossier)
    if (meta.merchant_name) {
      if (!g.noms.has(meta.merchant_name)) g.noms.set(meta.merchant_name, [])
      g.noms.get(meta.merchant_name)!.push(dossier)
    }
    if (meta.merchant_whatsapp) {
      if (!g.whatsapps.has(meta.merchant_whatsapp)) g.whatsapps.set(meta.merchant_whatsapp, [])
      g.whatsapps.get(meta.merchant_whatsapp)!.push(dossier)
    }
  }
  return groupes
}

/** Imprime, AVANT toute écriture, ce que l'import va fabriquer et ce qu'il
 *  va perdre. Le brief le dit : c'est cette liste qui a de la valeur — elle
 *  doit donc être visible dans la sortie du script lui-même, pas seulement
 *  reconstituée après coup dans un rapport en prose. */
function imprimerPertesDeRepresentation(catalogues: CatalogueLegacy[], groupes: Map<string, GroupePhone>) {
  const groupesFabriques = [...groupes.values()].filter((g) => g.fabrique)
  const catalseFabriques = groupesFabriques.reduce((s, g) => s + g.dossiers.length, 0)
  const catalseFideles = catalogues.length - catalseFabriques

  console.log(
    `\n=== IDENTITÉ MARCHANDE (${catalogues.length} catalogues) ===\n` +
      `${catalseFideles} catalogue(s) FIDÈLE(S) : rattachés à un merchant_phone réel de l'archive.\n` +
      `${catalseFabriques} catalogue(s) à IDENTITÉ FABRIQUÉE : ni merchant_phone ni merchant_name ` +
      `dans l'archive — un marchand synthétique (téléphone « inconnu-<dossier> ») a été créé pour ` +
      `chacun, à ne PAS confondre avec un import fidèle.`
  )
  for (const g of groupesFabriques) {
    console.log(`   FABRIQUÉ : ${g.dossiers[0]} -> téléphone synthétique « ${g.telephone} »`)
  }

  console.log(`\n=== PERTES DE REPRÉSENTATION DÉTECTÉES ===`)
  console.log(
    `Le nouveau modèle attache le nom et le whatsapp au MARCHAND, une fois pour toutes ; ` +
      `l'ancien les attachait au CATALOGUE, à chaque capture. Un marchand qui a changé de nom ou ` +
      `de numéro whatsapp entre deux captures ne peut plus être représenté qu'avec UNE valeur.`
  )

  let pertesNom = 0
  for (const g of groupes.values()) {
    if (g.noms.size <= 1) continue
    pertesNom++
    const dossierRetenu = g.dossiers[0]
    const nomRetenu = catalogues.find((c) => c.dossier === dossierRetenu)!.meta.merchant_name!
    console.log(`   PERTE merchant_name — téléphone ${g.telephone} :`)
    console.log(`     retenu  : "${nomRetenu}" (catalogue ${dossierRetenu}, premier dans l'ordre d'import)`)
    for (const [nom, dossiers] of g.noms) {
      if (nom === nomRetenu) continue
      console.log(`     jeté    : "${nom}" -> ${dossiers.length} catalogue(s) (${dossiers.join(", ")})`)
    }
  }
  if (pertesNom === 0) console.log(`   merchant_name : aucune divergence détectée.`)

  let pertesWhatsapp = 0
  for (const g of groupes.values()) {
    if (g.whatsapps.size <= 1) continue
    pertesWhatsapp++
    const dossierRetenu = g.dossiers[0]
    const whatsappRetenu = catalogues.find((c) => c.dossier === dossierRetenu)!.meta.merchant_whatsapp!
    console.log(`   PERTE merchant_whatsapp — téléphone ${g.telephone} :`)
    console.log(`     retenu  : "${whatsappRetenu}" (catalogue ${dossierRetenu}, premier dans l'ordre d'import)`)
    for (const [w, dossiers] of g.whatsapps) {
      if (w === whatsappRetenu) continue
      console.log(`     jeté    : "${w}" -> ${dossiers.length} catalogue(s) (${dossiers.join(", ")})`)
    }
  }
  // Un catalogue du groupe sans AUCUN whatsapp, alors que le marchand en a
  // un ailleurs, n'est pas une divergence de valeur mais mérite d'être noté :
  // rien n'est perdu pour LUI (il n'en portait pas), mais ce n'est pas
  // silencieux non plus.
  for (const g of groupes.values()) {
    if (g.whatsapps.size === 0) continue
    const sansWhatsapp = g.dossiers.filter((d) => !catalogues.find((c) => c.dossier === d)!.meta.merchant_whatsapp)
    if (sansWhatsapp.length) {
      console.log(`   NOTE merchant_whatsapp — téléphone ${g.telephone} : ${sansWhatsapp.join(", ")} n'en portait aucun (rien perdu pour ceux-ci).`)
    }
  }
  if (pertesWhatsapp === 0) console.log(`   merchant_whatsapp : aucune divergence de valeur détectée.`)

  const produitsAvecOptions: { dossier: string; label: string; options: unknown }[] = []
  for (const { dossier, meta } of catalogues) {
    for (const p of meta.products) {
      const options = p.options
      // On compte tout produit qui porte la clé `options`, même vide : la
      // clé elle-même prouve que l'ancien modèle avait un concept que le
      // nouveau (colors/sizes) ne reprend pas tel quel.
      if (options !== undefined && (!p.colors || p.colors.length === 0) && (!p.sizes || p.sizes.length === 0)) {
        produitsAvecOptions.push({ dossier, label: p.label, options })
      }
    }
  }
  console.log(
    `   PERTE products[].options : ${produitsAvecOptions.length} produit(s) portent ce champ (absent de ` +
      `publishCatalogueWorkflow, qui ne connaît que colors/sizes), sans ni colors ni sizes en repli :`
  )
  for (const p of produitsAvecOptions) {
    console.log(`     ${p.dossier} : "${p.label}" options=${JSON.stringify(p.options)}`)
  }

  console.log(
    `   PERTE metadata.created_at : les ${catalogues.length} catalogues portent une date de capture ` +
      `d'origine (horodatage Unix) que ce script ignore — le nouveau catalogue est horodaté à ` +
      `l'import, pas à la capture d'étal.`
  )

  return { catalseFideles, catalseFabriques, pertesNom, pertesWhatsapp, produitsAvecOptions }
}

export default async function seedLegacy({ container, args }: ExecArgs) {
  const archive = args[0]
  if (!archive) {
    throw new Error("Usage : npm run seed:legacy -- <chemin-archive>")
  }

  const racine = path.join(archive, "catalogues")
  if (!fs.existsSync(racine)) {
    throw new Error(
      `BLOCKED : archive introuvable à « ${racine} ». Rien n'a été importé — ` +
        `aucune donnée de substitution n'est générée à sa place.`
    )
  }

  const dossiers = fs
    .readdirSync(racine)
    .filter((d) => fs.statSync(path.join(racine, d)).isDirectory())
    .sort()

  if (dossiers.length !== NOMBRE_CATALOGUES_ATTENDU || !dossiers.includes(CATALOGUE_TEMOIN)) {
    throw new Error(
      `BLOCKED : archive incomplète. ${dossiers.length} répertoire(s) trouvé(s) ` +
        `(attendu ${NOMBRE_CATALOGUES_ATTENDU}) ; catalogue témoin ` +
        `« ${CATALOGUE_TEMOIN} » ${dossiers.includes(CATALOGUE_TEMOIN) ? "présent" : "ABSENT"}. ` +
        `Rien n'a été importé.`
    )
  }

  console.log(`Archive vérifiée : ${dossiers.length} catalogues, dont le témoin ${CATALOGUE_TEMOIN}.`)

  const catalogues: CatalogueLegacy[] = dossiers.map((dossier) => ({
    dossier,
    meta: JSON.parse(fs.readFileSync(path.join(racine, dossier, "metadata.json"), "utf-8")),
  }))
  const groupes = analyserIdentitesMarchandes(catalogues)
  imprimerPertesDeRepresentation(catalogues, groupes)

  // Ce script réalise un import À BLANC, pas une synchronisation : il ne
  // sait ni fusionner ni mettre à jour un import précédent, et le handle
  // marchand qu'il calcule est déterministe (même téléphone -> même
  // handle à chaque exécution). Le relancer sur une base déjà importée
  // ferait donc échouer CHAQUE catalogue à la création du marchand — un
  // échec de plomberie (handle déjà pris), pas un trou de représentation —
  // et ce script les distinguerait mal s'il les laissait simplement
  // remonter dans la liste des échecs. On refuse donc de démarrer : plus
  // sûr qu'une reprise partielle, qui dupliquerait silencieusement les
  // catalogues et produits des marchands déjà importés.
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const telephonesArchive = [...groupes.keys()]
  const { data: marchandsExistants } = await query.graph({
    entity: "merchant",
    fields: ["id", "phone", "handle"],
    filters: { phone: telephonesArchive },
  })
  if (marchandsExistants.length > 0) {
    const detail = (marchandsExistants as any[])
      .map((m) => `${m.phone} -> marchand ${m.id} (handle « ${m.handle} »)`)
      .join(" ; ")
    throw new Error(
      `BLOCKED : cette archive semble déjà importée. ${marchandsExistants.length} marchand(s) existent ` +
        `déjà avec un téléphone présent dans l'archive : ${detail}. Ce n'est pas un trou de ` +
        `représentation, c'est un ré-import détecté avant toute écriture — nettoyez ces marchands ` +
        `(et leurs catalogues/produits) avant de relancer, ou étendez ce script si un vrai besoin de ` +
        `ré-import récurrent apparaît. Rien n'a été importé.`
    )
  }

  await assurerRegionXof(container)

  const secret = "seed-legacy-secret-local"
  const etatVision: EtatVisionFactice = { produits: [] }
  const serveur = demarrerServeurVisionFactice(etatVision, secret)
  await new Promise<void>((resolve) => serveur.listen(0, resolve))
  const { port } = serveur.address() as { port: number }
  process.env.VISION_SERVICE_URL = `http://127.0.0.1:${port}`
  process.env.VISION_SERVICE_SECRET = secret

  const marchandsParTelephone = new Map<string, any>()
  // Nécessaire à la vérification d'isolation finale : les produits créés,
  // regroupés par marchand qui les a publiés.
  const produitsParMarchand = new Map<string, string[]>()
  const echecs: { catalogue: string; raison: string }[] = []
  let importes = 0
  let importesFideles = 0
  let importesFabriques = 0

  try {
    for (const { dossier, meta } of catalogues) {
      try {
        const telephone = meta.merchant_phone || `inconnu-${dossier}`
        const fabrique = groupes.get(telephone)!.fabrique

        if (!marchandsParTelephone.has(telephone)) {
          const { result } = await createMerchantWorkflow(container).run({
            input: {
              name: meta.merchant_name || "Marchand sans nom",
              handle: `legacy-${slug(meta.merchant_name || dossier)}-${dossier.slice(0, 4)}`,
              phone: telephone,
              whatsapp_phone: meta.merchant_whatsapp || undefined,
            },
          })
          marchandsParTelephone.set(telephone, result)
        }
        const marchand = marchandsParTelephone.get(telephone)

        const octets = fs.readFileSync(path.join(racine, dossier, "original.jpg"))

        // Le serveur factice répondra avec CES produits au prochain /detect.
        etatVision.produits = meta.products

        const { result: brouillon } = await analyzeCataloguePhotoWorkflow(container).run({
          input: {
            merchant_id: marchand.merchant_id,
            filename: `${dossier}.jpg`,
            content: octets.toString("binary"),
            title: `Catalogue ${dossier}`,
          },
        })

        // Le workflow renvoie ses zones dans le même ordre que les produits
        // envoyés au serveur de vision factice (voir create-catalogue-draft.ts :
        // un seul appel groupé, ordre d'entrée préservé). On les ré-associe
        // donc par index AVANT tout filtrage sur le prix — filtrer meta.products
        // en premier désynchroniserait l'index du produit filtré de celui de
        // sa zone d'origine, et associerait le mauvais article à la mauvaise
        // zone (mauvaises coordonnées d'annotation, mauvais lien produit↔zone).
        const paires = meta.products.map((produit, i) => ({ produit, zone: brouillon.zones[i] }))

        const zonesPourPublication = brouillon.zones.map((z) => ({
          id: z.id,
          x: z.x,
          y: z.y,
          width: z.width,
          height: z.height,
          category: z.detected_category,
        }))

        // Cohérent avec le brief : un produit sans prix dans l'archive est un
        // produit que le marchand a détecté mais jamais mis en vente — on ne
        // le publie pas, on ne l'invente pas non plus.
        const items = paires
          .filter((paire) => paire.produit.price)
          .map((paire) => ({
            zone_id: paire.zone.id,
            label: paire.produit.label,
            description: paire.produit.description,
            price: paire.produit.price!,
            quantity: 1,
            colors: paire.produit.colors ?? [],
            sizes: paire.produit.sizes ?? [],
          }))

        const { result: publication } = await publishCatalogueWorkflow(container).run({
          input: {
            catalogue_id: brouillon.catalogue_id,
            merchant_id: marchand.merchant_id,
            sales_channel_id: marchand.sales_channel_id,
            stock_location_id: marchand.stock_location_id,
            source_content: octets.toString("binary"),
            source_filename: `${dossier}.jpg`,
            zones: zonesPourPublication,
            items,
          },
        })

        const existants = produitsParMarchand.get(marchand.merchant_id) ?? []
        produitsParMarchand.set(marchand.merchant_id, [...existants, ...publication.product_ids])

        importes++
        if (fabrique) importesFabriques++
        else importesFideles++
        const etiquette = fabrique ? "IDENTITÉ FABRIQUÉE" : "fidèle"
        console.log(
          `  OK  ${dossier} (${items.length} article(s) publié(s), marchand « ${marchand.merchant_id} », ${etiquette})`
        )
      } catch (e) {
        // Les rejets de `.run()` d'un workflow ne sont pas des `Error` —
        // l'orchestrateur les sérialise en objet simple. `instanceof` serait
        // inconditionnellement faux ; seul `.message` survit de façon fiable.
        const raison = (e as any)?.message ?? String(e)
        echecs.push({ catalogue: dossier, raison })
        console.log(`  ÉCHEC ${dossier} : ${raison}`)
      }
    }
  } finally {
    await new Promise<void>((resolve) => serveur.close(() => resolve()))
  }

  // L'isolation est prouvée par les tests sur des données fabriquées. Ici
  // elle est vérifiée sur le corpus réel, où les marchands ont des noms, des
  // téléphones et des produits qui n'ont pas été choisis pour le test.
  //
  // Note de conception : le brief suggère `query.graph({ entity: "product",
  // filters: { sales_channel_id } })`. Vérifié empiriquement contre cette
  // base avant d'écrire ce script — Medusa refuse ce filtre ("Trying to
  // query by not existing property Product.sales_channel_id") : `product`
  // n'a pas de colonne `sales_channel_id`, seulement une relation
  // `sales_channels` posée par le lien de module. La vérification ci-dessous
  // utilise donc le même mécanisme déjà prouvé dans
  // catalogue-publish.spec.ts (champ `sales_channels.id`, filtré par les
  // identifiants de produits réellement créés pour chacun des deux
  // marchands) plutôt qu'un filtre qui lèverait pour une raison de
  // plomberie et non d'isolation.
  const marchandsAvecProduits = [...marchandsParTelephone.values()].filter(
    (m) => (produitsParMarchand.get(m.merchant_id) ?? []).length > 0
  )

  if (marchandsAvecProduits.length >= 2) {
    const [m1, m2] = marchandsAvecProduits
    const idsM1 = produitsParMarchand.get(m1.merchant_id)!
    const idsM2 = produitsParMarchand.get(m2.merchant_id)!

    const { data } = await query.graph({
      entity: "product",
      fields: ["id", "sales_channels.id"],
      filters: { id: [...idsM1, ...idsM2] },
    })
    const canauxParProduit = new Map<string, string[]>(
      (data as any[]).map((p) => [p.id, (p.sales_channels ?? []).map((c: any) => c.id)])
    )

    const anomalies: string[] = []
    for (const id of idsM1) {
      const canaux = canauxParProduit.get(id) ?? []
      if (!canaux.includes(m1.sales_channel_id) || canaux.includes(m2.sales_channel_id)) {
        anomalies.push(id)
      }
    }
    for (const id of idsM2) {
      const canaux = canauxParProduit.get(id) ?? []
      if (!canaux.includes(m2.sales_channel_id) || canaux.includes(m1.sales_channel_id)) {
        anomalies.push(id)
      }
    }

    if (anomalies.length) {
      throw new Error(
        `ISOLATION ROMPUE : ${anomalies.length} produit(s) mal rattaché(s) entre les ` +
          `marchands ${m1.merchant_id} et ${m2.merchant_id}`
      )
    }
    console.log(
      `\nIsolation vérifiée sur le corpus réel : ${idsM1.length} produit(s) pour ` +
        `${m1.merchant_id}, ${idsM2.length} pour ${m2.merchant_id}, aucun croisement de canal.`
    )
  } else {
    console.log("\nIsolation non vérifiée : moins de deux marchands avec au moins un produit publié.")
  }

  console.log(
    `\n${importes} catalogues importés (${importesFideles} fidèle(s) à une identité réelle de l'archive, ` +
      `${importesFabriques} à identité marchande FABRIQUÉE), ${marchandsParTelephone.size} marchands créés`
  )
  if (echecs.length) {
    console.log(`\n${echecs.length} ÉCHEC(S) — chacun révèle un champ que le nouveau modèle n'accueille pas :`)
    for (const e of echecs) console.log(`  ${e.catalogue} : ${e.raison}`)
  }
}
