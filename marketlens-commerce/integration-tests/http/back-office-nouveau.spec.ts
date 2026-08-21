import { medusaIntegrationTestRunner } from "@medusajs/test-utils"

jest.setTimeout(120000)

const MOT_DE_PASSE = "motdepasse-de-test"

/** Le back-office est un formulaire HTML, pas une API JSON : la connexion
 *  arrive en `application/x-www-form-urlencoded`, comme dans
 *  back-office-acces.spec.ts. */
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

medusaIntegrationTestRunner({
  testSuite: ({ api }) => {
    /** Inscrit une commerçante et rend un cookie de session prêt à l'emploi,
     *  en repassant par l'écran de connexion — pas par `/auth/session` —
     *  comme le fait back-office-acces.spec.ts. */
    const connecter = async (email: string, name: string, handle: string, phone: string) => {
      const insc = await api.post("/auth/merchant/emailpass/register", {
        email,
        password: MOT_DE_PASSE,
      })
      await api.post(
        "/merchant/register",
        { name, handle, phone },
        { headers: { authorization: `Bearer ${insc.data.token}` } }
      )
      const f = formulaire({ email, motdepasse: MOT_DE_PASSE })
      const r = await api.post("/marchand/connexion", f.corps, f.options)
      return cookieDe(r)
    }

    describe("Écran de prise de photo de l'étal", () => {
      it("sert l'écran de prise de photo à une commerçante connectée", async () => {
        const cookie = await connecter(
          "nouveau-bo@marketlens.test",
          "Étal Nouveau",
          "etal-nouveau",
          "22990000081"
        )
        expect(cookie).toBeTruthy()

        const p = await api.get("/marchand/nouveau", { headers: { cookie } })
        expect(p.status).toBe(200)
        expect(p.headers["content-type"]).toContain("text/html")
        expect(p.data).toContain('capture="environment"')
        // La limite doit être annoncée AVANT l'envoi, pas découverte après.
        expect(p.data).toContain("18")
      })

      it("redirige un visiteur sans session", async () => {
        const p = await api.get("/marchand/nouveau", {
          maxRedirects: 0,
          validateStatus: () => true,
        })
        expect(p.status).toBe(302)
        expect(p.headers.location).toBe("/marchand/connexion")
      })

      it("échappe un nom de boutique hostile affiché dans l'en-tête", async () => {
        const cookie = await connecter(
          "nouveau-hostile-bo@marketlens.test",
          `Étal <script>alert(1)</script>`,
          "etal-nouveau-hostile",
          "22990000082"
        )
        expect(cookie).toBeTruthy()

        const p = await api.get("/marchand/nouveau", { headers: { cookie } })
        expect(p.status).toBe(200)
        expect(p.data).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
        expect(p.data).not.toContain("<script>alert(1)</script>")
      })
    })
  },
})
