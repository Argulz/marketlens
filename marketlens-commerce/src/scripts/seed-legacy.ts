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
}

type MetadataLegacy = {
  id: string
  products: ProduitLegacy[]
  merchant_name?: string
  merchant_phone?: string
  merchant_whatsapp?: string
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

  try {
    for (const dossier of dossiers) {
      const chemin = path.join(racine, dossier)
      try {
        const meta: MetadataLegacy = JSON.parse(
          fs.readFileSync(path.join(chemin, "metadata.json"), "utf-8")
        )
        const telephone = meta.merchant_phone || `inconnu-${dossier}`

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

        const octets = fs.readFileSync(path.join(chemin, "original.jpg"))

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
        console.log(`  OK  ${dossier} (${items.length} article(s) publié(s), marchand « ${marchand.merchant_id} »)`)
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

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
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

  console.log(`\n${importes} catalogues importés, ${marchandsParTelephone.size} marchands créés`)
  if (echecs.length) {
    console.log(`\n${echecs.length} ÉCHEC(S) — chacun révèle un champ que le nouveau modèle n'accueille pas :`)
    for (const e of echecs) console.log(`  ${e.catalogue} : ${e.raison}`)
  }
}
