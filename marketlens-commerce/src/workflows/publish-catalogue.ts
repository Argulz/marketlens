import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import {
  createProductsWorkflow,
  createInventoryLevelsWorkflow,
  createRemoteLinkStep,
  uploadFilesWorkflow,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/framework/utils"
import { VISUAL_CATALOG_MODULE } from "../modules/visual-catalog"
import { annotateCatalogueStep } from "./steps/annotate-catalogue"
import { publierCatalogueStep } from "./steps/publier-catalogue"

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
    const donneesProduits = transform(input, (i) => ({
      products: i.items.map((item) => {
        const options: { title: string; values: string[] }[] = []
        if (item.colors.length) options.push({ title: "Couleur", values: item.colors })
        if (item.sizes.length) options.push({ title: "Taille", values: item.sizes })
        if (!options.length) options.push({ title: "Format", values: ["Unique"] })

        return {
          title: item.label,
          description: item.description ?? "",
          status: "published" as const,
          sales_channels: [{ id: i.sales_channel_id }],
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
