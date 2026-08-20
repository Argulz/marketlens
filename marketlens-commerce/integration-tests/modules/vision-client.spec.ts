import http from "http"
import {
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
        fermer: () => new Promise((r) => serveur.close(() => r(undefined))),
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
})
