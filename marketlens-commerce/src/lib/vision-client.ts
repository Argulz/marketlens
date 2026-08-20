export type ZoneDetectee = {
  label: string
  x: number
  y: number
  width: number
  height: number
  category: string
}

export type ProduitAnnote = ZoneDetectee & { price: string }

/** Le service de vision a refusé notre requête (4xx) : c'est nous qui sommes fautifs. */
export class VisionRefuse extends Error {}

/** Le service de vision est injoignable ou en panne (transport, 5xx). */
export class VisionIndisponible extends Error {}

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
  let reponse: Response
  try {
    reponse = await fetch(`${url}${chemin}`, {
      method: "POST",
      headers: { "X-Vision-Secret": secret },
      body: corps,
    })
  } catch (e) {
    throw new VisionIndisponible(
      `Service de vision injoignable sur ${url} : ${(e as Error).message}`
    )
  }

  if (reponse.status >= 400 && reponse.status < 500) {
    throw new VisionRefuse(
      `Le service de vision a refusé la requête (${reponse.status})`
    )
  }
  if (!reponse.ok) {
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
