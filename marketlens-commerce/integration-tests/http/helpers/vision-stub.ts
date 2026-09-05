import http from "http"

/** Sert des réponses figées à la place du service de vision. Aucun appel
 *  Gemini n'a lieu : ni la suite par défaut, ni ce fichier ne sortent du
 *  processus. */
export async function servirVisionFactice(reponses: {
  detect?: unknown
  annotate?: Buffer
  statutDetect?: number
  statutAnnotate?: number
  /** Ferme `/detect` en 500 : le serveur ne sert plus QUE l'annotation.
   *  C'est ce qui permet de prouver qu'un chemin (la regeneration d'image
   *  apres correction des prix) n'appelle jamais la detection — s'il le
   *  faisait, il echouerait au lieu de rester vert. Une simple absence de
   *  serveur ne le prouverait pas : l'annotation echouerait elle aussi. */
  annotateSeulement?: boolean
}) {
  const serveur = http.createServer((req, res) => {
    if (req.url?.startsWith("/detect")) {
      if (reponses.annotateSeulement) {
        res.writeHead(500)
        return res.end("{}")
      }
      if (reponses.statutDetect && reponses.statutDetect >= 400) {
        res.writeHead(reponses.statutDetect)
        return res.end("{}")
      }
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify(reponses.detect ?? { products: [], count: 0 }))
    }
    if (reponses.statutAnnotate && reponses.statutAnnotate >= 400) {
      res.writeHead(reponses.statutAnnotate)
      return res.end("{}")
    }
    res.writeHead(200, { "content-type": "image/jpeg" })
    res.end(reponses.annotate ?? Buffer.from([0xff, 0xd8, 0xff, 0xdb]))
  })

  await new Promise((r) => serveur.listen(0, () => r(undefined)))
  const port = (serveur.address() as any).port
  process.env.VISION_SERVICE_URL = `http://127.0.0.1:${port}`
  process.env.VISION_SERVICE_SECRET = "secret-de-test"

  return { fermer: () => new Promise((r) => serveur.close(() => r(undefined))) }
}
