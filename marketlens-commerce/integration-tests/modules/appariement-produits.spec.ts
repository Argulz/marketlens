import {
  apparierParHandle,
  handleProduitPublie,
} from "../../src/workflows/appariement-produits"

// Test purement fonctionnel (même statut que vision-client.spec.ts dans ce
// dossier) : il n'a besoin d'aucune base ni d'aucun conteneur, parce que
// l'appariement article ↔ produit est justement redevenu une fonction pure
// qu'on peut interroger directement.

const ARTICLES = [
  { zone_id: "zone_01AAAAAAAAAAAAAAAAAAAAAAAA", label: "Tomates fraîches" },
  { zone_id: "zone_01BBBBBBBBBBBBBBBBBBBBBBBB", label: "Pagne wax" },
  { zone_id: "zone_01CCCCCCCCCCCCCCCCCCCCCCCC", label: "Ignames" },
]

function produitsPour(marchand: string, articles: typeof ARTICLES) {
  return articles.map((a, i) => ({
    id: `prod_${i}`,
    handle: handleProduitPublie(marchand, a),
  }))
}

describe("Appariement article ↔ produit publié", () => {
  it("apparie par handle, quel que soit l'ordre dans lequel les produits sont rendus", async () => {
    // Le cœur du correctif. L'appariement se faisait par INDEX
    // (`d.produits[i]`) : il supposait que `createProductsWorkflow` rend ses
    // produits dans l'ordre exact des entrées. Si cet ordre changeait un
    // jour, la zone « Tomates » pointerait vers le produit « Pagne wax », le
    // stock de l'un irait à l'autre, et aucune erreur ne serait levée — la
    // vitrine mentirait en silence. On rend donc les produits DANS L'ORDRE
    // INVERSE : par index, l'appariement serait faux ; par handle, il reste
    // vrai.
    const produits = produitsPour("etal-awa", ARTICLES).reverse()

    const paires = apparierParHandle("etal-awa", ARTICLES, produits)

    expect(paires).toHaveLength(3)
    for (const { item, produit } of paires) {
      expect(produit.handle).toBe(handleProduitPublie("etal-awa", item))
    }
    // L'ordre rendu suit celui des ARTICLES, pas celui des produits : c'est
    // ce qui permet aux appelants de garder `item.quantity` et `item.zone_id`
    // en face du bon produit.
    expect(paires.map((p) => p.item.label)).toEqual([
      "Tomates fraîches",
      "Pagne wax",
      "Ignames",
    ])
    expect(paires.map((p) => p.produit.id)).toEqual(["prod_0", "prod_1", "prod_2"])
  })

  it("lève une erreur explicite quand un handle attendu est absent, plutôt qu'un appariement faux", async () => {
    const produits = produitsPour("etal-awa", ARTICLES).slice(1)

    expect(() => apparierParHandle("etal-awa", ARTICLES, produits)).toThrow(
      /Tomates fraîches/
    )
    expect(() => apparierParHandle("etal-awa", ARTICLES, produits)).toThrow(
      new RegExp(handleProduitPublie("etal-awa", ARTICLES[0]))
    )
  })

  it("engendre un handle déterministe, distinct par zone et par marchand", async () => {
    const [tomates] = ARTICLES
    // Stable : à marchand, libellé et zone égaux, le handle est toujours le
    // même — c'est ce qui rend l'appariement par handle possible.
    expect(handleProduitPublie("etal-awa", tomates)).toBe(
      handleProduitPublie("etal-awa", tomates)
    )
    // Distinct entre marchands (index de handle unique à l'échelle de
    // l'instance) et entre zones d'un même marchand (un même étal republie
    // couramment le même libellé).
    expect(handleProduitPublie("etal-awa", tomates)).not.toBe(
      handleProduitPublie("etal-kwame", tomates)
    )
    expect(handleProduitPublie("etal-awa", tomates)).not.toBe(
      handleProduitPublie("etal-awa", { ...tomates, zone_id: ARTICLES[1].zone_id })
    )
  })
})
