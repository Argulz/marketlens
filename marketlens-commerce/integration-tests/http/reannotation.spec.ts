import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { VISUAL_CATALOG_MODULE } from "../../src/modules/visual-catalog"
import { servirVisionFactice } from "./helpers/vision-stub"
import {
  CatalogueDeTest,
  publierUnCatalogue,
} from "./helpers/catalogue-publie"

jest.setTimeout(90 * 1000)

/** Tous les prix XOF posés sur les variantes du produit d'une zone, et les
 *  quantités en stock de leurs articles d'inventaire. Lecture directe, sans
 *  passer par la route : c'est la seule façon de voir qu'une correction
 *  REMPLACE le prix au lieu d'en empiler un second (le détail rendu par la
 *  route ne montre que le premier prix XOF trouvé, donc un doublon y
 *  resterait invisible). */
async function etatCommercial(
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

/**
 * Supprime les NIVEAUX de stock (couples article d'inventaire × emplacement)
 * des variantes d'une zone, sans toucher au lien variante → article
 * d'inventaire.
 *
 * C'est exactement l'état qui fait lever `ensureInventoryLevels`
 * (node_modules/@medusajs/inventory/dist/services/inventory-module.js:38-80,
 * appelé par `updateInventoryLevels_` ligne 200-204) : le SECOND workflow de
 * la route échoue alors que le PREMIER a déjà écrit les prix. Une panne
 * atteignable en production — un emplacement de stock remplacé, un article
 * dépeuplé — et non une injection de faute artificielle.
 */
async function supprimerNiveauxDeStock(
  api: any,
  getContainer: any,
  m: CatalogueDeTest,
  zoneId: string
): Promise<void> {
  const catalogue = await detailCatalogue(api, m)
  const zone = catalogue.zones.find((z: any) => z.id === zoneId)
  const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)

  const { data: produits } = await query.graph({
    entity: "product",
    fields: ["id", "variants.inventory_items.inventory_item_id"],
    filters: { id: [zone.product.id] },
  })
  const idsInventaire: string[] = []
  for (const variante of (produits[0] as any).variants ?? []) {
    for (const article of (variante.inventory_items ?? []).filter(Boolean)) {
      idsInventaire.push(article.inventory_item_id)
    }
  }

  const { data: niveaux } = await query.graph({
    entity: "inventory_level",
    fields: ["inventory_item_id", "location_id"],
    filters: { inventory_item_id: idsInventaire },
  })
  // Sans ce filet, un changement de modèle ferait passer le test pour de
  // mauvaises raisons : rien à supprimer, donc rien à faire échouer, donc
  // une correction entièrement réussie et un test vert qui ne prouve rien.
  expect((niveaux as any[]).length).toBeGreaterThan(0)

  const inventaire: any = getContainer().resolve(Modules.INVENTORY)
  for (const niveau of niveaux as any[]) {
    await inventaire.deleteInventoryLevel(niveau.inventory_item_id, niveau.location_id)
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
        let rendue: string
        try {
          const r = await api.patch(
            `/merchant/catalogues/${m.catalogueId}/items`,
            { items: [{ zone_id: m.zones[0].id, price: "2500", quantity: 7 }] },
            { headers: { authorization: `Bearer ${m.jeton}` } }
          )
          expect(r.status).toBe(200)
          expect(r.data.avertissement).toBeUndefined()
          rendue = r.data.annotated_image_url
        } finally {
          await vision.fermer()
        }

        // L'URL de la NOUVELLE image est rendue directement : l'écran de
        // correction n'a pas à refaire un GET du détail pour rafraîchir la
        // vignette qu'il vient de faire redessiner.
        expect(rendue).toBeTruthy()
        expect(rendue).not.toBe(avant)
        // Et c'est bien celle qui est en base, pas une valeur inventée.
        expect(await urlAnnotee(api, m)).toBe(rendue)

        expect(await urlAnnotee(api, m)).not.toBe(avant)
        expect(await prixDeLaZone(api, m, m.zones[0].id)).toBe(2500)
        // La zone non corrigée garde son prix : la correction ne touche que
        // les articles envoyés.
        expect(await prixDeLaZone(api, m, m.zones[1].id)).toBe(500)

        // Le prix est REMPLACÉ, pas empilé : un second ensemble de prix
        // resterait invisible du détail rendu par la route (qui ne montre
        // que le premier prix XOF trouvé) tout en faussant la vitrine.
        // Et la quantité suit vraiment le stock.
        const corrigee = await etatCommercial(api, getContainer, m, m.zones[0].id)
        expect(corrigee.prixXof).toEqual([2500])
        expect(corrigee.quantites).toEqual([7])

        const intacte = await etatCommercial(api, getContainer, m, m.zones[1].id)
        expect(intacte.prixXof).toEqual([500])
        expect(intacte.quantites).toEqual([10])
      })

      it("refuse en français quand l'image source n'est plus disponible", async () => {
        const m = await publierUnCatalogue(api, "etal-source-perdue", "22990000102")
        const avant = await urlAnnotee(api, m)
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
        // Le libellé PROPRE à cette branche, pas le mot « image » que les
        // DEUX avertissements de la route contiennent : sans cela, le test
        // resterait vert si `lireImageSourceStep` ne vérifiait plus
        // `source_image_id`, si `ErreurImageSourceIndisponible` ne posait
        // plus son `name`, ou si la comparaison sur `e?.name` était fausse —
        // le chemin générique aboutirait au même 200 (aucun serveur de
        // vision factice n'est ouvert ici). C'est ce libellé qui prouve le
        // mécanisme `.name`, seule chose qui survit à la sérialisation de
        // l'orchestrateur.
        expect(r.data.avertissement).toContain("photo d'origine")
        // L'URL rendue est l'ANCIENNE, celle qui est réellement en base :
        // le contraste succès / avertissement doit se lire aussi dans la
        // charge utile, pas seulement dans la phrase.
        expect(r.data.annotated_image_url).toBe(avant)
        expect(await urlAnnotee(api, m)).toBe(avant)
        expect(await prixDeLaZone(api, m, m.zones[0].id)).toBe(3000)
      })

      it("garde les prix écrits et le DIT quand seul le stock échoue", async () => {
        // Les prix et les quantités partent en DEUX `.run()` distincts, donc
        // en deux transactions : un échec du second ne compense pas le
        // premier. Rendre alors « la correction a échoué » serait le pire
        // comportement possible — la commerçante ressaisirait des prix déjà
        // en base, ou croirait sa vitrine inchangée alors qu'elle ne l'est
        // pas.
        const m = await publierUnCatalogue(api, "etal-stock-perdu", "22990000107")
        await supprimerNiveauxDeStock(api, getContainer, m, m.zones[0].id)

        const vision = await servirVisionFactice({ annotateSeulement: true })
        let r: any
        try {
          r = await api
            .patch(
              `/merchant/catalogues/${m.catalogueId}/items`,
              { items: [{ zone_id: m.zones[0].id, price: "1234", quantity: 9 }] },
              { headers: { authorization: `Bearer ${m.jeton}` } }
            )
            .catch((e: any) => e.response)
        } finally {
          await vision.fermer()
        }

        expect(r.status).toBe(200)
        expect(r.data.avertissement).toContain("quantités")
        // L'avertissement ne parle QUE du stock : l'image, elle, a bien été
        // régénérée (le serveur factice répond sur /annotate).
        expect(r.data.avertissement).not.toContain("image")

        // La moitié qui compte : le prix écrit par le PREMIER workflow est
        // bien en base. Un test qui n'assertait que le code de statut
        // resterait vert sur une route qui rendrait 200 sans rien écrire.
        expect(await prixDeLaZone(api, m, m.zones[0].id)).toBe(1234)
        const etat = await etatCommercial(api, getContainer, m, m.zones[0].id)
        expect(etat.prixXof).toEqual([1234])
      })

      it("compose les deux avertissements sans doublon et sans promettre de réessai reprenable", async () => {
        // Deux pannes sur la MÊME requête : le stock (reprenable) et la
        // photo d'origine perdue (définitive). La composition doit dire les
        // deux — chacune une seule fois — et ne promettre « Réessayez » que
        // si TOUTES les pannes le sont, ce qui n'est pas le cas ici.
        const m = await publierUnCatalogue(api, "etal-double-echec", "22990000108")
        await supprimerNiveauxDeStock(api, getContainer, m, m.zones[0].id)
        const service: any = getContainer().resolve(VISUAL_CATALOG_MODULE)
        await service.updateVisualCatalogues({
          id: m.catalogueId,
          source_image_id: null,
        })

        const r = await api
          .patch(
            `/merchant/catalogues/${m.catalogueId}/items`,
            { items: [{ zone_id: m.zones[0].id, price: "4321", quantity: 6 }] },
            { headers: { authorization: `Bearer ${m.jeton}` } }
          )
          .catch((e: any) => e.response)

        expect(r.status).toBe(200)
        expect(r.data.avertissement).toContain("quantités")
        expect(r.data.avertissement).toContain("photo d'origine")
        // Une seule phrase « Les prix sont à jour » : le fragment du stock
        // n'est pas répété, et la promesse de réessai n'apparaît pas
        // puisque la perte de l'image source n'est pas reprenable.
        expect(
          r.data.avertissement.split("Les prix sont à jour").length - 1
        ).toBe(1)
        expect(r.data.avertissement).not.toContain("Réessayez")

        // Le prix, lui, est bien écrit malgré les deux pannes.
        expect(await prixDeLaZone(api, m, m.zones[0].id)).toBe(4321)
      })

      it("refuse en français la correction d'une zone jamais mise en vente", async () => {
        // Contrainte 9 : une zone peut ne porter aucun produit. L'écran de
        // correction affiche UNE LIGNE PAR ZONE ; s'il soumet toutes ses
        // lignes, une seule zone jamais tarifée doit faire échouer la
        // correction entière en 400 français — pas en panne technique, et
        // pas à moitié.
        const m = await publierUnCatalogue(api, "etal-zone-muette", "22990000106", 1)
        const avant = await urlAnnotee(api, m)

        const r = await api
          .patch(
            `/merchant/catalogues/${m.catalogueId}/items`,
            {
              items: [
                { zone_id: m.zones[0].id, price: "7777", quantity: 4 },
                { zone_id: m.zones[1].id, price: "1000", quantity: 1 },
              ],
            },
            { headers: { authorization: `Bearer ${m.jeton}` } }
          )
          .catch((e: any) => e.response)

        expect(r.status).toBe(400)
        expect(r.data.message).toContain("n'a pas été mise en vente")
        // Le libellé de LA zone fautive, pour que la commerçante sache
        // laquelle retirer de sa correction.
        expect(r.data.message).toContain(m.zones[1].detected_label)

        // Le refus tombe AVANT toute écriture : la zone valide du même envoi
        // garde son prix de publication, et l'image n'a pas été redessinée.
        expect(await prixDeLaZone(api, m, m.zones[0].id)).toBe(5000)
        expect(await urlAnnotee(api, m)).toBe(avant)
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
