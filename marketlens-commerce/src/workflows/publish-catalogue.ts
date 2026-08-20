import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import {
  createProductsWorkflow,
  createInventoryLevelsWorkflow,
  createRemoteLinkStep,
  uploadFilesWorkflow,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { Modules, toHandle } from "@medusajs/framework/utils"
import { VISUAL_CATALOG_MODULE } from "../modules/visual-catalog"
import { annotateCatalogueStep } from "./steps/annotate-catalogue"
import { publierCatalogueStep } from "./steps/publier-catalogue"
import { verifierCatalogueMarchandStep } from "./steps/verifier-catalogue-marchand"
import { validerItemsPublicationStep } from "./steps/valider-items-publication"

export type ItemPublication = {
  zone_id: string
  label: string
  description?: string
  price: string
  quantity: number
  colors: string[]
  sizes: string[]
}

export type PublishCatalogueInput = {
  catalogue_id: string
  merchant_id: string
  sales_channel_id: string
  stock_location_id: string
  source_content: string
  source_filename: string
  zones: { id: string; x: number; y: number; width: number; height: number; category: string }[]
  items: ItemPublication[]
}

/** Produit cartésien des couleurs et tailles. Sans variante déclarée,
 *  Medusa exige tout de même une variante : on en crée une, unique. */
function variantesDe(item: ItemPublication) {
  const couleurs = item.colors.length ? item.colors : [null]
  const tailles = item.sizes.length ? item.sizes : [null]
  const combinaisons: { titre: string; options: Record<string, string> }[] = []

  for (const c of couleurs) {
    for (const t of tailles) {
      const options: Record<string, string> = {}
      if (c) options["Couleur"] = c
      if (t) options["Taille"] = t
      combinaisons.push({
        titre: [c, t].filter(Boolean).join(" / ") || "Unique",
        options,
      })
    }
  }
  return combinaisons
}

const publishCatalogueWorkflow = createWorkflow(
  "publish-catalogue",
  (input: PublishCatalogueInput) => {
    // Deux contrôles en tête, avant toute écriture : (1) le catalogue
    // appartient bien au marchand indiqué — sans quoi `merchant_id` ne
    // servirait à rien — et (2) chaque article référence une zone connue
    // avec un prix et une quantité exploitables. Les repousser après la
    // création des produits transformerait une saisie fautive en produits,
    // stock et liens orphelins, compensés au mieux-effort plutôt
    // qu'évités.
    const verif = verifierCatalogueMarchandStep({
      catalogue_id: input.catalogue_id,
      merchant_id: input.merchant_id,
    })

    validerItemsPublicationStep({
      zones: input.zones,
      items: input.items,
    })

    const donneesProduits = transform({ input, verif }, (d) => ({
      products: d.input.items.map((item) => {
        const options: { title: string; values: string[] }[] = []
        if (item.colors.length) options.push({ title: "Couleur", values: item.colors })
        if (item.sizes.length) options.push({ title: "Taille", values: item.sizes })
        if (!options.length) options.push({ title: "Format", values: ["Unique"] })

        return {
          title: item.label,
          // Le handle produit porte un index unique à l'échelle de
          // l'instance (`IDX_product_handle_unique`), tout comme le
          // handle catalogue ou le sous-domaine marchand — une troisième
          // construction globale que rien d'autre ne protège. Sans
          // préfixe, Medusa le dérive du titre (`toHandle(title)`) et deux
          // marchands publiant « Tomates fraîches » se disputent le même
          // handle : le second échoue après création de ses produits,
          // compensés mais sur un message technique en anglais. On
          // préfixe donc par le handle du marchand plutôt que son
          // identifiant : déjà unique, et lisible dans une URL
          // publique (`/c/<handle>/...`) là où l'identifiant ne l'est pas.
          //
          // Le préfixe marchand ferme la collision ENTRE marchands, pas
          // CHEZ un même marchand : un marchand qui publie deux fois
          // « Tomates fraîches » (même catalogue avec deux zones identiques,
          // ou deux catalogues successifs) produit deux fois le même
          // `toHandle(title)` et se percute lui-même. Le corpus archivé
          // (tâche 8) heurte réellement ce cas — un même étal republie
          // plusieurs fois « Jean » ou « Chemise à carreaux » au fil de ses
          // catalogues. On désambiguïse donc par un second suffixe dérivé de
          // `zone_id` : cet identifiant est déjà unique (clé primaire de
          // `catalogue_zone`), et sa portion finale porte l'aléa du ULID (les
          // dix premiers caractères ne codent qu'un horodatage — voir
          // generate-entity-id.js — potentiellement partagé par des zones
          // créées dans le même lot). Cette désambiguïsation reste stable :
          // à zone_id égal, le handle produit est toujours le même.
          handle: `${d.verif.merchant_handle}-${toHandle(item.label)}-${item.zone_id.slice(-8).toLowerCase()}`,
          description: item.description ?? "",
          status: "published" as const,
          sales_channels: [{ id: d.input.sales_channel_id }],
          options,
          variants: variantesDe(item).map((v) => ({
            title: v.titre,
            options: Object.keys(v.options).length ? v.options : { Format: "Unique" },
            manage_inventory: true,
            prices: [{ amount: Number(item.price), currency_code: "xof" }],
          })),
        }
      }),
    }))

    const produits = createProductsWorkflow.runAsStep({ input: donneesProduits })

    // `createProductsWorkflow` ne renvoie PAS les articles d'inventaire sur
    // ses variantes (vérifié dans
    // node_modules/@medusajs/core-flows/dist/product/workflows/create-product-variants.js :
    // la réponse est `{ ...variant, prices }`, sans `inventory_items` — cet
    // article n'est créé et lié qu'en interne, via `createLinksWorkflow`,
    // jamais rattaché à l'objet variante retourné). Il faut donc le
    // requêter explicitement une fois les produits committés.
    const idsProduits = transform({ produits }, (d) => ({
      ids: d.produits.map((p) => p.id),
    }))

    const produitsAvecInventaire = useQueryGraphStep({
      entity: "product",
      fields: ["id", "variants.id", "variants.inventory_items.inventory_item_id"],
      filters: { id: idsProduits.ids },
    })

    // Les articles d'inventaire naissent avec les variantes ; on leur pose un
    // niveau à l'emplacement du marchand, seul endroit où son stock existe.
    const niveaux = transform({ input, produits, produitsAvecInventaire }, (d) => {
      const inventaireParVariante = new Map<string, { inventory_item_id: string }[]>()
      for (const produit of d.produitsAvecInventaire.data as any[]) {
        for (const variante of produit.variants ?? []) {
          // La liaison variante ↔ article d'inventaire peut renvoyer des
          // entrées nulles côté requête distante (jointure optionnelle) ;
          // on les écarte avant de les utiliser.
          const articles = (variante.inventory_items ?? []).filter(
            (a: unknown): a is { inventory_item_id: string } => !!a
          )
          inventaireParVariante.set(variante.id, articles)
        }
      }

      return {
        inventory_levels: d.produits.flatMap((produit, i) =>
          produit.variants.flatMap((variante) =>
            (inventaireParVariante.get(variante.id) ?? []).map((article) => ({
              inventory_item_id: article.inventory_item_id,
              location_id: d.input.stock_location_id,
              stocked_quantity: d.input.items[i].quantity,
            }))
          )
        ),
      }
    })

    createInventoryLevelsWorkflow.runAsStep({ input: niveaux })

    createRemoteLinkStep(
      transform({ input, produits }, (d) =>
        d.input.items.map((item, i) => ({
          [VISUAL_CATALOG_MODULE]: { catalogue_zone_id: item.zone_id },
          [Modules.PRODUCT]: { product_id: d.produits[i].id },
        }))
      )
    )

    // L'annotation vient APRÈS la création des produits : c'est ce qui rend
    // le test de compensation capable d'exercer leur retour arrière.
    const annotee = annotateCatalogueStep(
      transform(input, (i) => ({
        content: i.source_content,
        filename: i.source_filename,
        produits: i.items.map((item) => {
          const zone = i.zones.find((z) => z.id === item.zone_id)!
          return {
            label: item.label,
            x: zone.x, y: zone.y, width: zone.width, height: zone.height,
            category: zone.category,
            price: item.price,
          }
        }),
      }))
    )

    const fichierAnnote = uploadFilesWorkflow.runAsStep({
      input: {
        files: [
          transform({ input, annotee }, (d) => ({
            filename: `annote-${d.input.source_filename}`,
            mimeType: "image/jpeg",
            content: d.annotee,
            access: "public" as const,
          })),
        ],
      },
    })

    const catalogue = publierCatalogueStep(
      transform({ input, fichierAnnote }, (d) => ({
        catalogue_id: d.input.catalogue_id,
        annotated_image_url: d.fichierAnnote[0].url,
      }))
    )

    return new WorkflowResponse(
      transform({ input, produits, catalogue }, (d) => ({
        catalogue_id: d.input.catalogue_id,
        product_ids: d.produits.map((p) => p.id),
        annotated_image_url: d.catalogue.annotated_image_url,
      }))
    )
  }
)

export default publishCatalogueWorkflow
