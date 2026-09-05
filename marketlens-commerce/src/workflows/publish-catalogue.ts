import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import {
  createProductsWorkflow,
  createInventoryLevelsWorkflow,
  createRemoteLinkStep,
  useQueryGraphStep,
} from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/framework/utils"
import { VISUAL_CATALOG_MODULE } from "../modules/visual-catalog"
import { annoterCatalogueWorkflow } from "./annoter-catalogue"
import { publierCatalogueStep } from "./steps/publier-catalogue"
import { verifierCatalogueMarchandStep } from "./steps/verifier-catalogue-marchand"
import { validerItemsPublicationStep } from "./steps/valider-items-publication"
import { apparierParHandle, handleProduitPublie } from "./appariement-produits"

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
  // Identifiant de fichier de la photo d'origine, persisté sur le catalogue
  // par `analyzeCataloguePhotoWorkflow`. C'est la seule entrée dont
  // l'annotation a besoin : le contenu de l'image n'est plus transporté en
  // mémoire depuis la route, il est relu du stockage par
  // `annoterCatalogueWorkflow`. Nullable parce que les catalogues créés
  // avant cette colonne n'en ont pas.
  source_image_id: string | null
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
          // Handle engendré par `handleProduitPublie` (appariement-produits.ts),
          // seule définition de cette construction : les deux appariements en
          // aval (quantité de stock, lien zone → produit) recalculent le même
          // handle pour retrouver LEUR produit. Une seconde copie de cette
          // formule ici, même identique aujourd'hui, ferait divergence
          // demain — et l'appariement redeviendrait faux en silence.
          handle: handleProduitPublie(d.verif.merchant_handle, item),
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
    const niveaux = transform({ input, produits, produitsAvecInventaire, verif }, (d) => {
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

      // La quantité saisie sur un article doit atterrir sur LE produit de cet
      // article. L'appariement par index (`d.input.items[i]`) supposait que
      // `createProductsWorkflow` rende ses produits dans l'ordre des entrées :
      // un changement d'ordre y aurait envoyé le stock des tomates sur le
      // pagne, sans lever la moindre erreur.
      const inventory_levels = apparierParHandle(
        d.verif.merchant_handle,
        d.input.items,
        d.produits
      ).flatMap(({ item, produit }) =>
        produit.variants.flatMap((variante) =>
          (inventaireParVariante.get(variante.id) ?? []).map((article) => ({
            inventory_item_id: article.inventory_item_id,
            location_id: d.input.stock_location_id,
            stocked_quantity: item.quantity,
          }))
        )
      )

      // « Du vrai stock » est la promesse centrale de la publication, et son
      // mode d'échec était MUET : appeler `createInventoryLevelsWorkflow`
      // avec un tableau vide ne crée aucun niveau, ne lève rien, et laisse
      // basculer le catalogue en `published` avec des produits sans stock —
      // invendables. Un tableau vide ici signifie qu'aucune variante ne porte
      // d'article d'inventaire : une incohérence interne (et non une faute de
      // saisie, d'où une erreur nue que la route compte en 500), pas un état
      // qu'on publie.
      if (inventory_levels.length === 0) {
        throw new Error(
          "Aucun niveau de stock à créer : aucune variante publiée ne porte d'article d'inventaire. Publication interrompue."
        )
      }

      return { inventory_levels }
    })

    createInventoryLevelsWorkflow.runAsStep({ input: niveaux })

    // Même appariement par handle que pour les niveaux de stock : c'est ce
    // lien qui fait dire à la vitrine « cette zone de l'image, c'est ce
    // produit ». Apparié par index, il aurait pu faire pointer la zone des
    // tomates vers le pagne wax — une vitrine qui mentirait sans qu'aucune
    // erreur ne soit levée.
    createRemoteLinkStep(
      transform({ input, produits, verif }, (d) =>
        apparierParHandle(d.verif.merchant_handle, d.input.items, d.produits).map(
          ({ item, produit }) => ({
            [VISUAL_CATALOG_MODULE]: { catalogue_zone_id: item.zone_id },
            [Modules.PRODUCT]: { product_id: produit.id },
          })
        )
      )
    )

    // L'annotation vient APRÈS la création des produits : c'est ce qui rend
    // le test de compensation capable d'exercer leur retour arrière.
    //
    // Elle passe par `annoterCatalogueWorkflow`, partagé avec la
    // republication et la correction de prix : la publication n'a plus
    // d'étape d'annotation à elle. Elle ne lui transmet plus le contenu de
    // l'image — que seule la publication possédait — mais l'identifiant du
    // fichier source, que le flux relit lui-même depuis le stockage.
    const annotee = annoterCatalogueWorkflow.runAsStep({
      input: transform(input, (i) => ({
        catalogue_id: i.catalogue_id,
        source_image_id: i.source_image_id,
        produits: i.items.map((item) => {
          const zone = i.zones.find((z) => z.id === item.zone_id)!
          return {
            label: item.label,
            x: zone.x, y: zone.y, width: zone.width, height: zone.height,
            category: zone.category,
            price: item.price,
          }
        }),
      })),
    })

    // `annoterCatalogueWorkflow` a déjà posé `annotated_image_url` ; ce step
    // reste le SEUL à faire basculer le statut en `published`, et sa
    // compensation restaure l'état exact d'avant. Lui repasser la même URL
    // est sans effet de bord : les compensations se déroulant en ordre
    // inverse, celle-ci restaure d'abord l'URL d'avant la publication, puis
    // celle du flux d'annotation restaure la même — l'état final est bien
    // celui d'avant.
    const catalogue = publierCatalogueStep(
      transform({ input, annotee }, (d) => ({
        catalogue_id: d.input.catalogue_id,
        annotated_image_url: d.annotee.annotated_image_url,
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
