import { toHandle } from "@medusajs/framework/utils"

/** Le minimum qu'un article de publication doit porter pour qu'on puisse
 *  calculer son handle produit : sa zone et son libellé. */
export type ArticleAApparier = { zone_id: string; label: string }

/**
 * Handle du produit publié pour un article donné.
 *
 * Trois composantes, chacune pour une collision distincte :
 *  - le handle du marchand, parce que l'index `IDX_product_handle_unique` est
 *    unique à l'échelle de l'INSTANCE : sans lui, deux marchands publiant
 *    « Tomates fraîches » se disputent le même handle ;
 *  - le libellé, pour qu'une URL publique reste lisible ;
 *  - la fin du `zone_id`, parce que le préfixe marchand ne ferme pas la
 *    collision d'un marchand avec LUI-MÊME (un même étal republie couramment
 *    « Jean » au fil de ses catalogues). Ce sont les DERNIERS caractères qui
 *    sont pris : les dix premiers d'un ULID ne codent qu'un horodatage, que
 *    deux zones créées dans le même lot partagent.
 *
 * Cette fonction est la SEULE définition du handle produit. Elle est pure et
 * déterministe : c'est ce qui permet d'apparier un article et son produit par
 * handle plutôt que par position (voir `apparierParHandle`).
 */
export function handleProduitPublie(
  merchantHandle: string,
  item: ArticleAApparier
): string {
  return `${merchantHandle}-${toHandle(item.label)}-${item.zone_id
    .slice(-8)
    .toLowerCase()}`
}

/**
 * Apparie chaque article à SON produit, par handle.
 *
 * L'appariement se faisait par index (`d.produits[i]`), ce qui supposait que
 * `createProductsWorkflow` rende ses produits dans l'ordre exact des entrées.
 * Cette hypothèse n'est garantie par aucun contrat : si l'ordre changeait, la
 * zone « Tomates » pointerait vers le produit « Pagne wax », le stock de l'un
 * irait à l'autre, aucune erreur ne serait levée, et la vitrine mentirait en
 * silence. Le handle, lui, est déterministe par article : l'appariement
 * devient une vérité vérifiable plutôt qu'une hypothèse.
 *
 * Un handle attendu et absent lève, plutôt que de produire silencieusement un
 * appariement faux.
 */
export function apparierParHandle<
  I extends ArticleAApparier,
  P extends { handle: string }
>(merchantHandle: string, items: I[], produits: P[]): { item: I; produit: P }[] {
  const parHandle = new Map(produits.map((p) => [p.handle, p]))

  return items.map((item) => {
    const handle = handleProduitPublie(merchantHandle, item)
    const produit = parHandle.get(handle)
    if (!produit) {
      throw new Error(
        `Appariement impossible : aucun produit créé ne porte le handle attendu « ${handle} » pour l'article « ${item.label} ».`
      )
    }
    return { item, produit }
  })
}
