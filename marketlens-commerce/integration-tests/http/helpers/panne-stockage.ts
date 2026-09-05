import { Modules } from "@medusajs/framework/utils"

/**
 * Coupe le STOCKAGE le temps d'un appel : `getAsBuffer` échoue avec un code
 * errno qui n'est PAS `ENOENT`.
 *
 * C'est la panne TRANSITOIRE — volume démonté, disque saturé, seau distant
 * injoignable — par opposition au fichier définitivement effacé. La photo de
 * la commerçante est intacte ; seul le stockage ne répond pas. Il n'existe
 * aucun autre moyen de produire cet état : on ne fabrique pas un fichier
 * dont la lecture échoue « temporairement » sur commande.
 *
 * Partagé entre les deux fichiers qui l'éprouvent, parce que la MÊME panne
 * doit sortir différemment selon l'appelant — 500 sur la remise en ligne,
 * 200 assorti d'un avertissement reprenable sur la correction des prix — et
 * que deux injections distinctes ne prouveraient plus que c'est bien la même.
 */
export async function pendantUnePanneDeStockage<T>(
  getContainer: any,
  action: () => Promise<T>
): Promise<T> {
  const fichiers: any = getContainer().resolve(Modules.FILE)
  const original = fichiers.getAsBuffer
  fichiers.getAsBuffer = async () => {
    const panne: any = new Error("EIO: i/o error, read")
    panne.code = "EIO"
    throw panne
  }
  try {
    return await action()
  } finally {
    fichiers.getAsBuffer = original
  }
}
