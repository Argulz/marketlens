import http from "http"
import {
  NOM_VISION_INDISPONIBLE,
  NOM_VISION_REFUSE,
  VisionIndisponible,
  VisionRefuse,
  annoterImage,
  detecterProduits,
} from "../../src/lib/vision-client"

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0])

function servir(gestionnaire): Promise<{ url: string; fermer: () => Promise<void>; recus: any[] }> {
  const recus: any[] = []
  return new Promise((resoudre) => {
    const serveur = http.createServer((req, res) => {
      recus.push({ url: req.url, secret: req.headers["x-vision-secret"] })
      gestionnaire(req, res)
    })
    serveur.listen(0, () => {
      const port = (serveur.address() as any).port
      resoudre({
        url: `http://127.0.0.1:${port}`,
        fermer: () =>
          new Promise((r) => {
            // Une requête laissée sans réponse (test du dépassement de délai)
            // garde sa socket ouverte : `close()` seul ne rendrait jamais
            // la main et Jest ne sortirait pas.
            serveur.closeAllConnections()
            serveur.close(() => r(undefined))
          }),
        recus,
      })
    })
  })
}

describe("Client du service de vision", () => {
  // Chaque test doit pouvoir être lancé seul, filtré (`-t`) ou réordonné :
  // les deux variables sont donc reposées avant chaque test plutôt que
  // laissées à la charge d'un voisin (process.env est global au process,
  // et --runInBand ne protège pas contre un `-t` qui saute un test).
  beforeEach(() => {
    process.env.VISION_SERVICE_URL = "http://127.0.0.1:0"
    process.env.VISION_SERVICE_SECRET = "secret-de-test"
    // Même raison : le délai de requête est lu depuis l'environnement à
    // chaque appel, un test qui l'abaisse ne doit pas le laisser au suivant.
    delete process.env.VISION_REQUEST_TIMEOUT_MS
  })

  it("transmet le secret partagé et rend les zones détectées", async () => {
    const s = await servir((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        products: [{ label: "Tomates", x: 250, y: 400, width: 200, height: 150, category: "fruits_legumes" }],
        count: 1,
      }))
    })
    try {
      process.env.VISION_SERVICE_URL = s.url

      const zones = await detecterProduits(JPEG, "etal.jpg")
      expect(zones).toHaveLength(1)
      expect(zones[0].label).toBe("Tomates")
      expect(s.recus[0].secret).toBe("secret-de-test")
    } finally {
      await s.fermer()
    }
  })

  it("distingue un refus amont d'une indisponibilité", async () => {
    const refus = await servir((_req, res) => { res.writeHead(400); res.end("{}") })
    try {
      process.env.VISION_SERVICE_URL = refus.url
      await expect(detecterProduits(JPEG, "etal.jpg")).rejects.toBeInstanceOf(VisionRefuse)
    } finally {
      await refus.fermer()
    }

    const panne = await servir((_req, res) => { res.writeHead(502); res.end("{}") })
    try {
      process.env.VISION_SERVICE_URL = panne.url
      await expect(detecterProduits(JPEG, "etal.jpg")).rejects.toBeInstanceOf(VisionIndisponible)
    } finally {
      await panne.fermer()
    }
  })

  it("classe une authentification refusée ou un quota amont épuisé en indisponibilité, jamais en refus", async () => {
    // 401 (secret partagé mal configuré côté service Python) et 429 (quota
    // Gemini épuisé) sont des pannes de notre côté ou de l'amont : les
    // classer en VisionRefuse accuserait la photo du marchand pour une
    // cause qui lui est totalement étrangère, et la route les rendrait en
    // 400 au lieu du 503 attendu en supervision.
    const authInvalide = await servir((_req, res) => { res.writeHead(401); res.end("{}") })
    try {
      process.env.VISION_SERVICE_URL = authInvalide.url
      await expect(detecterProduits(JPEG, "etal.jpg")).rejects.toBeInstanceOf(VisionIndisponible)
    } finally {
      await authInvalide.fermer()
    }

    const quotaEpuise = await servir((_req, res) => { res.writeHead(429); res.end("{}") })
    try {
      process.env.VISION_SERVICE_URL = quotaEpuise.url
      await expect(detecterProduits(JPEG, "etal.jpg")).rejects.toBeInstanceOf(VisionIndisponible)
    } finally {
      await quotaEpuise.fermer()
    }
  })

  it("rend les octets JPEG annotés", async () => {
    const s = await servir((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" })
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))
    })
    try {
      process.env.VISION_SERVICE_URL = s.url

      const octets = await annoterImage(JPEG, "etal.jpg", [
        { label: "Tomates", x: 250, y: 400, width: 200, height: 150, category: "fruits_legumes", price: "500" },
      ])
      expect(octets.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    } finally {
      await s.fermer()
    }
  })

  it("traduit un amont qui ne répond jamais en indisponibilité, jamais en refus", async () => {
    // `fetch` n'impose AUCUN délai par défaut côté Node : sans `signal`, un
    // service de vision figé au niveau TCP faisait pendre la requête du
    // marchand indéfiniment. Le service Python porte une échéance globale de
    // 45 s ; le client Medusa doit caler la sienne au-dessus, et un
    // dépassement doit être une indisponibilité (l'amont n'a pas répondu),
    // jamais un refus (qui accuserait notre requête).
    const s = await servir((req) => {
      // On draine le corps sans jamais répondre. Sans ce `resume()`, le corps
      // multipart resterait non lu, la socket se remplirait et le client
      // récolterait un ECONNRESET — on éprouverait alors le chemin
      // « transport en erreur » au lieu du dépassement de délai visé.
      req.resume()
    })
    try {
      process.env.VISION_SERVICE_URL = s.url
      process.env.VISION_REQUEST_TIMEOUT_MS = "300"

      const debut = Date.now()
      await expect(detecterProduits(JPEG, "etal.jpg")).rejects.toBeInstanceOf(
        VisionIndisponible
      )
      // Le délai configuré a bien agi : la promesse n'a pas attendu la valeur
      // par défaut (une minute), et n'a surtout pas pendu.
      expect(Date.now() - debut).toBeLessThan(10_000)
    } finally {
      await s.fermer()
    }
  })

  it("nomme ses erreurs, faute de quoi les journaux et la route ne lisent que « Error »", async () => {
    // `class VisionRefuse extends Error {}` sans `this.name` laisse
    // `Error.prototype.name` — les journaux affichent « Error », et surtout
    // la route ne peut plus distinguer un refus d'une panne : le rejet d'un
    // `.run()` de workflow n'est pas l'instance d'origine (l'orchestrateur la
    // remplace par une copie en objet simple), donc `instanceof` est
    // inutilisable et seul `.name` survit.
    expect(new VisionRefuse("x").name).toBe(NOM_VISION_REFUSE)
    expect(new VisionIndisponible("x").name).toBe(NOM_VISION_INDISPONIBLE)
    expect(NOM_VISION_REFUSE).not.toBe(NOM_VISION_INDISPONIBLE)
  })
})
