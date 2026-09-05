import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { SCRIPT_STOCK } from "../../src/lib/pages/stock"
import { servirVisionFactice } from "./helpers/vision-stub"

jest.setTimeout(90 * 1000)

const MOT_DE_PASSE = "motdepasse-de-test"

/** Le back-office est un formulaire HTML, pas une API JSON : la connexion
 *  arrive en `application/x-www-form-urlencoded`, comme dans
 *  back-office-acces.spec.ts et back-office-nouveau.spec.ts. */
const formulaire = (champs: Record<string, string>) => ({
  corps: new URLSearchParams(champs).toString(),
  options: {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    maxRedirects: 0,
    validateStatus: () => true,
  },
})

const cookieDe = (reponse: any): string =>
  ((reponse.headers["set-cookie"] as string[] | undefined) ?? [])
    .map((c) => c.split(";")[0])
    .join("; ")

/** Corps multipart d'une photo d'étal minimale, copié de
 *  catalogue-detail.spec.ts : ce fichier n'éprouve jamais le décodage de
 *  l'image, seulement l'écran rendu par la route. */
function corpsPhoto(titre: string): FormData {
  const form = new FormData()
  form.append(
    "image",
    new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" }),
    "etal.jpg"
  )
  form.append("title", titre)
  return form
}

const ZONE_PAGNE = { label: "Pagne", x: 250, y: 400, width: 200, height: 150, category: "textile" }
const ZONE_TOMATES = { label: "Tomates", x: 700, y: 500, width: 250, height: 300, category: "fruits_legumes" }

medusaIntegrationTestRunner({
  testSuite: ({ api }) => {
    /** Inscrit une commerçante, ouvre une session par cookie — le même
     *  chemin qu'emprunte un navigateur, pas `/auth/session` — puis analyse
     *  une photo pour elle via la vraie route HTTP `POST /merchant/catalogues`
     *  (multipart). La session par cookie ouvre aussi les routes JSON
     *  `/merchant/*` (rappelé dans les contraintes globales du lot) : pas
     *  besoin d'un second jeton Bearer ici. */
    const connecterEtAnalyser = async (nomHandle: string, phone: string) => {
      const email = `${nomHandle}@marketlens.test`
      const insc = await api.post("/auth/merchant/emailpass/register", {
        email,
        password: MOT_DE_PASSE,
      })
      await api.post(
        "/merchant/register",
        { name: `Étal ${nomHandle}`, handle: nomHandle, phone },
        { headers: { authorization: `Bearer ${insc.data.token}` } }
      )
      const f = formulaire({ email, motdepasse: MOT_DE_PASSE })
      const connexion = await api.post("/marchand/connexion", f.corps, f.options)
      const cookie = cookieDe(connexion)

      const vision = await servirVisionFactice({
        detect: { products: [ZONE_PAGNE, ZONE_TOMATES], count: 2 },
      })
      try {
        const reponse = await api.post(
          "/merchant/catalogues",
          corpsPhoto(`Catalogue de ${nomHandle}`),
          { headers: { cookie } }
        )
        return {
          cookie,
          catalogueId: reponse.data.catalogue.id as string,
          zones: reponse.data.zones as { id: string; detected_label: string }[],
        }
      } finally {
        await vision.fermer()
      }
    }

    describe("Écran de tarification et publication", () => {
      it("affiche une ligne par zone, avec le libellé détecté pré-rempli", async () => {
        const { cookie, catalogueId, zones } = await connecterEtAnalyser(
          "etal-tarif", "22990000091"
        )
        const p = await api.get(`/marchand/catalogues/${catalogueId}`, { headers: { cookie } })
        expect(p.status).toBe(200)
        expect(p.headers["content-type"]).toContain("text/html")
        for (const z of zones) {
          expect(p.data).toContain(z.detected_label)
          expect(p.data).toContain(z.id)
        }
        // D5 : le total doit être annoncé, pas subi.
        expect(p.data).toContain("Quantité par déclinaison")

        // Contrat des attributs `data-*` que le script client consomme :
        // sans eux, aucun envoi n'est possible depuis cette page.
        expect(p.data).toContain("data-vendre")
        expect(p.data).toContain("data-lib")
        expect(p.data).toContain("data-prix")
        expect(p.data).toContain("data-qte")
        expect(p.data).toContain("data-coul")
        expect(p.data).toContain("data-tail")
        expect(p.data).toContain("data-total")
        expect(p.data).toContain('id="publier"')

        // Le rappel de ce que l'IA a vu reste visible même après que la
        // commerçante modifie le libellé (contrainte 10).
        for (const z of zones) {
          expect(p.data).toContain(`reconnu : ${z.detected_label}`)
        }
      })

      it("sert le même calcul de stock testé unitairement, sans lecture dupliquée de la quantité (findings R13/R14)", async () => {
        const { cookie, catalogueId } = await connecterEtAnalyser(
          "etal-tarif-stock", "22990000097"
        )
        const p = await api.get(`/marchand/catalogues/${catalogueId}`, { headers: { cookie } })
        expect(p.status).toBe(200)

        // R14 : `SCRIPT_STOCK` (src/lib/pages/stock.ts, couvert par
        // integration-tests/modules/stock.spec.ts, garde `new Function`
        // comprise) doit se retrouver OCTET POUR OCTET dans la page — pas
        // seulement les noms des fonctions qu'il déclare. Une simple
        // vérification de présence resterait verte même si la route
        // recopiait une version divergente, ou si `stock.ts` gagnait un
        // import ou une constante de portée module qui casserait la page en
        // silence dans le navigateur (rien de tel n'apparaîtrait dans une
        // vérification par présence). L'identité exacte de la chaîne est ici
        // la seule preuve, au niveau HTTP, que ce qui est testé
        // unitairement est bien ce qui est livré (l'exécution du calcul
        // lui-même n'est vérifiable qu'au niveau unitaire, aucun navigateur
        // n'intervenant dans cette suite HTTP).
        expect(p.data).toContain(SCRIPT_STOCK)

        // R13 : `recalculer()` (affichage) et le gestionnaire de publication
        // (envoi) doivent lire la quantité par le même appel — deux occurrences
        // de `lireQuantite(tr.querySelector("[data-qte]").value)`, une par
        // usage. L'ancienne lecture sans filet (`Number(tr.querySelector(...)
        // .value)`, sans passer par `lireQuantite`) ne doit plus apparaître :
        // c'est exactement la divergence affichage/envoi que R13 corrige.
        const occurrences = p.data.split(
          'lireQuantite(tr.querySelector("[data-qte]").value)'
        ).length - 1
        expect(occurrences).toBe(2)
        expect(p.data).not.toContain('quantity: Number(tr.querySelector("[data-qte]").value)')
      })

      it("ne sert pas le catalogue d'une autre commerçante", async () => {
        const a = await connecterEtAnalyser("etal-tarif-a", "22990000092")
        const b = await connecterEtAnalyser("etal-tarif-b", "22990000093")
        const p = await api.get(`/marchand/catalogues/${a.catalogueId}`, {
          headers: { cookie: b.cookie }, maxRedirects: 0, validateStatus: () => true,
        })
        expect(p.status).toBe(404)
        expect(p.data).not.toContain(a.zones[0].detected_label)
        // La page générique ne nomme ni la boutique ni le catalogue.
        expect(p.data).not.toContain("etal-tarif-a")
      })

      it("rend 404 avec la page générique pour un identifiant qui n'existe pas du tout", async () => {
        const { cookie } = await connecterEtAnalyser("etal-tarif-inconnu", "22990000094")
        const p = await api.get(`/marchand/catalogues/cat_inexistant_${Date.now()}`, {
          headers: { cookie }, maxRedirects: 0, validateStatus: () => true,
        })
        expect(p.status).toBe(404)
        expect(p.data).toContain("Introuvable")
      })

      it("redirige vers l'écran de correction des prix quand le catalogue est déjà publié", async () => {
        const { cookie, catalogueId, zones } = await connecterEtAnalyser(
          "etal-tarif-publie", "22990000095"
        )

        const visionPub = await servirVisionFactice({
          detect: { products: [ZONE_PAGNE, ZONE_TOMATES], count: 2 },
        })
        try {
          const pub = await api.post(
            `/merchant/catalogues/${catalogueId}/publish`,
            {
              items: [
                {
                  zone_id: zones[0].id,
                  label: "Pagne wax",
                  price: "5000",
                  quantity: 2,
                  colors: [],
                  sizes: [],
                },
              ],
            },
            { headers: { cookie } }
          )
          expect(pub.status).toBe(200)
        } finally {
          await visionPub.fermer()
        }

        const p = await api.get(`/marchand/catalogues/${catalogueId}`, {
          headers: { cookie }, maxRedirects: 0, validateStatus: () => true,
        })
        expect(p.status).toBe(302)
        expect(p.headers.location).toBe(`/marchand/catalogues/${catalogueId}/prix`)
      })

      it("échappe un libellé détecté hostile plutôt que de le rendre tel quel", async () => {
        const email = "tarif-hostile@marketlens.test"
        const insc = await api.post("/auth/merchant/emailpass/register", {
          email,
          password: MOT_DE_PASSE,
        })
        await api.post(
          "/merchant/register",
          { name: "Étal Tarif Hostile", handle: "etal-tarif-hostile", phone: "22990000096" },
          { headers: { authorization: `Bearer ${insc.data.token}` } }
        )
        const f = formulaire({ email, motdepasse: MOT_DE_PASSE })
        const connexion = await api.post("/marchand/connexion", f.corps, f.options)
        const cookie = cookieDe(connexion)

        // Le libellé vient de Gemini — un tiers — comme le rappelle le brief :
        // rien ne garantit qu'il ne porte jamais de balisage.
        const vision = await servirVisionFactice({
          detect: {
            products: [
              { label: `Pagne <script>alert(1)</script>`, x: 250, y: 400, width: 200, height: 150, category: "textile" },
            ],
            count: 1,
          },
        })
        let catalogueId: string
        try {
          const reponse = await api.post(
            "/merchant/catalogues",
            corpsPhoto("Catalogue hostile"),
            { headers: { cookie } }
          )
          catalogueId = reponse.data.catalogue.id
        } finally {
          await vision.fermer()
        }

        const p = await api.get(`/marchand/catalogues/${catalogueId}`, { headers: { cookie } })
        expect(p.status).toBe(200)
        expect(p.data).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
        expect(p.data).not.toContain("<script>alert(1)</script>")
      })

      it("bloque la publication avec un message français quand la quantité est invalide", async () => {
        // Ce refus est porté par `validerItemsPublicationStep`
        // (src/workflows/steps/valider-items-publication.ts), pas par le
        // script injecté dans la page (celui-ci bloquerait l'envoi AVANT
        // même l'appel réseau, ce que cette suite HTTP — sans navigateur —
        // ne peut pas exercer). Ce test couvre donc le filet côté serveur :
        // même un appel qui contournerait la lecture côté écran reçoit un
        // message français exploitable, jamais une erreur technique brute.
        const { cookie, catalogueId, zones } = await connecterEtAnalyser(
          "etal-tarif-qte-invalide", "22990000098"
        )
        const pub = await api.post(
          `/merchant/catalogues/${catalogueId}/publish`,
          {
            items: [
              {
                zone_id: zones[0].id,
                label: "Pagne wax",
                price: "5000",
                quantity: -1,
                colors: [],
                sizes: [],
              },
            ],
          },
          { headers: { cookie }, validateStatus: () => true }
        )
        expect(pub.status).toBe(400)
        expect(pub.data.message).toBe(
          "La quantité de « Pagne wax » doit être un entier positif ou nul."
        )
      })

      it("redirige un visiteur sans session vers l'écran de connexion", async () => {
        const p = await api.get("/marchand/catalogues/peu-importe", {
          maxRedirects: 0,
          validateStatus: () => true,
        })
        expect(p.status).toBe(302)
        expect(p.headers.location).toBe("/marchand/connexion")
      })
    })
  },
})
