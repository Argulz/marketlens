export type ZoneDetectee = {
  label: string
  x: number
  y: number
  width: number
  height: number
  category: string
}

export type ProduitAnnote = ZoneDetectee & { price: string }

/**
 * Noms portés par les deux erreurs ci-dessous, et testés par les routes.
 *
 * Pourquoi des constantes plutôt qu'`instanceof` : quand ces erreurs sont
 * levées depuis une étape de workflow, le rejet du `.run()` n'est jamais
 * l'instance d'origine — l'orchestrateur la remplace par une COPIE en objet
 * simple (voir workflows/steps/erreur-validation-publication.ts pour la
 * démonstration détaillée). Seul `.name` survit à cette sérialisation.
 * `class VisionRefuse extends Error {}` sans `this.name` laisse
 * `Error.prototype.name`, c'est-à-dire « Error » : les deux erreurs
 * devenaient indistinguables pour la route ET illisibles dans les journaux.
 */
export const NOM_VISION_REFUSE = "VisionRefuse"
export const NOM_VISION_INDISPONIBLE = "VisionIndisponible"

/** Le service de vision a refusé notre requête (4xx) : c'est nous qui sommes fautifs. */
export class VisionRefuse extends Error {
  constructor(message: string) {
    super(message)
    this.name = NOM_VISION_REFUSE
  }
}

/** Le service de vision est injoignable ou en panne (transport, 5xx, délai
 *  dépassé). */
export class VisionIndisponible extends Error {
  constructor(message: string) {
    super(message)
    this.name = NOM_VISION_INDISPONIBLE
  }
}

/**
 * Délai maximal d'un appel au service de vision, en millisecondes.
 *
 * `fetch` n'impose AUCUN délai par défaut côté Node : sans ce garde-fou, un
 * service de vision figé au niveau TCP faisait pendre la requête du marchand
 * indéfiniment. Le service Python porte une échéance globale de 45 s
 * (`VISION_DEADLINE_S`, services/vision/app/config.py) : la valeur par
 * défaut est calée AU-DESSUS, pour que le service en amont ait le temps de
 * rendre sa propre réponse d'échec (un 504 exploitable) plutôt que de se
 * faire couper par nous.
 */
const DELAI_PAR_DEFAUT_MS = 60_000

function delaiMs(): number {
  const brut = Number(process.env.VISION_REQUEST_TIMEOUT_MS)
  // Une variable d'environnement absente, vide ou non numérique ne doit pas
  // désarmer le garde-fou : on retombe sur la valeur par défaut plutôt que
  // sur `NaN`, qu'`AbortSignal.timeout` refuserait.
  return Number.isFinite(brut) && brut > 0 ? brut : DELAI_PAR_DEFAUT_MS
}

function configuration() {
  const url = process.env.VISION_SERVICE_URL
  const secret = process.env.VISION_SERVICE_SECRET
  if (!url || !secret) {
    throw new Error(
      "VISION_SERVICE_URL et VISION_SERVICE_SECRET doivent être configurés"
    )
  }
  return { url: url.replace(/\/$/, ""), secret }
}

async function appeler(chemin: string, corps: FormData): Promise<Response> {
  const { url, secret } = configuration()
  const delai = delaiMs()
  let reponse: Response
  try {
    reponse = await fetch(`${url}${chemin}`, {
      method: "POST",
      headers: { "X-Vision-Secret": secret },
      body: corps,
      // Un SEUL signal borne la requête ET la lecture du corps de réponse :
      // il reste attaché au flux, donc les drainages `.text()` ci-dessous
      // sont bornés par la même échéance. C'est ce qui permet de fermer la
      // fuite de sockets (corps non drainé) sans réintroduire un drainage
      // non borné — et pourquoi il ne faut PAS poser un second délai autour
      // de ces drainages.
      signal: AbortSignal.timeout(delai),
    })
  } catch (e) {
    // Un dépassement de délai est une INDISPONIBILITÉ (l'amont n'a pas
    // répondu), jamais un refus : un `VisionRefuse` accuserait notre propre
    // requête et la route le traduirait en 400, rendant une panne
    // d'infrastructure invisible à la supervision.
    const cause = e as Error
    if (cause?.name === "TimeoutError" || cause?.name === "AbortError") {
      throw new VisionIndisponible(
        `Service de vision sans réponse sur ${url} après ${delai} ms`
      )
    }
    throw new VisionIndisponible(
      `Service de vision injoignable sur ${url} : ${cause?.message}`
    )
  }

  // Tous les 4xx ne se valent pas. Le service de vision rend 401 quand notre
  // secret partagé est mal configuré et 429 quand le quota Gemini est épuisé :
  // ce sont des pannes de notre côté ou de l'amont, pas des requêtes fautives.
  // Les classer en refus accuserait la photo du marchand d'une cause qui lui est
  // étrangère et, surtout, les rendrait en 4xx — donc invisibles en supervision,
  // qui surveille les 5xx. Seuls les codes qui mettent réellement en cause la
  // requête restent des refus ; tout autre 4xx (404 sur une route disparue,
  // 405, 409…) trahit une incohérence de déploiement et relève de la panne.
  const CODES_REQUETE_FAUTIVE = [400, 413, 415, 422]
  if (CODES_REQUETE_FAUTIVE.includes(reponse.status)) {
    await reponse.text().catch(() => {})
    throw new VisionRefuse(
      `Le service de vision a refusé la requête (${reponse.status})`
    )
  }
  if (!reponse.ok) {
    await reponse.text().catch(() => {})
    throw new VisionIndisponible(
      `Le service de vision a échoué (${reponse.status})`
    )
  }
  return reponse
}

export async function detecterProduits(
  octets: Buffer,
  nomFichier: string
): Promise<ZoneDetectee[]> {
  const corps = new FormData()
  corps.append("image", new Blob([new Uint8Array(octets)]), nomFichier)
  const reponse = await appeler("/detect", corps)
  const donnees = (await reponse.json()) as { products: ZoneDetectee[] }
  return donnees.products
}

export async function annoterImage(
  octets: Buffer,
  nomFichier: string,
  produits: ProduitAnnote[]
): Promise<Buffer> {
  const corps = new FormData()
  corps.append("image", new Blob([new Uint8Array(octets)]), nomFichier)
  corps.append("products", JSON.stringify(produits))
  const reponse = await appeler("/annotate", corps)
  return Buffer.from(await reponse.arrayBuffer())
}
