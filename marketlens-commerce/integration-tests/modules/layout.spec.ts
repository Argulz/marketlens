// Gabarit commun du back-office marchand. Le brief ne fait passer `layout.ts`
// par aucun test rouge/vert explicite ; on l'écrit quand même, car c'est ce
// fichier qui garantit que le titre et le nom de boutique échappent (un nom
// de boutique hostile ne doit pas s'évader de l'en-tête) et que la page 404
// commune ne distingue jamais « identifiant inexistant » de « catalogue
// d'une autre commerçante » — deux tâches ultérieures s'appuient dessus.
import { html } from "../../src/lib/html"
import { page, pageIntrouvable } from "../../src/lib/pages/layout"

describe("Gabarit commun du back-office", () => {
  it("échappe le titre et le nom de marchand", () => {
    const sortie = page({
      titre: `<script>t</script>`,
      marchand: `<script>m</script>`,
      corps: html`<p>corps</p>`,
    })
    expect(sortie).not.toContain("<script>t</script>")
    expect(sortie).not.toContain("<script>m</script>")
    expect(sortie).toContain("&lt;script&gt;t&lt;/script&gt;")
    expect(sortie).toContain("&lt;script&gt;m&lt;/script&gt;")
  })

  it("inclut le corps fourni sans l'échapper une seconde fois", () => {
    // La valeur passe par une interpolation `${}` : c'est elle qui doit être
    // échappée par `html`, pas la partie statique du gabarit de `corps`.
    const sortie = page({ titre: "Accueil", corps: html`<p>${"Bonjour & bienvenue"}</p>` })
    expect(sortie).toContain("<p>Bonjour &amp; bienvenue</p>")
  })

  it("n'affiche pas le bloc « qui » quand aucun marchand n'est connu", () => {
    const sortie = page({ titre: "Connexion", corps: html`<p>x</p>` })
    expect(sortie).not.toContain('class="qui"')
  })

  it("rend un doctype et un <title> suffixé MarketLens", () => {
    const sortie = page({ titre: "Mes catalogues", corps: html`<p>x</p>` })
    expect(sortie.startsWith("<!doctype html>")).toBe(true)
    expect(sortie).toContain("<title>Mes catalogues — MarketLens</title>")
  })

  it("pageIntrouvable ne nomme ni boutique ni catalogue", () => {
    // Servie aussi bien pour un identifiant inexistant que pour le catalogue
    // d'une autre commerçante : un message distinct confirmerait l'existence
    // du second, donc le texte doit rester générique dans les deux cas.
    const sortie = pageIntrouvable()
    expect(sortie).toContain("Introuvable")
    expect(sortie.toLowerCase()).not.toContain("boutique")
    expect(sortie.toLowerCase()).not.toContain("catalogue")
  })

  it("pageIntrouvable rend une page complète", () => {
    const sortie = pageIntrouvable()
    expect(sortie.startsWith("<!doctype html>")).toBe(true)
    expect(sortie).toContain("<title>Introuvable — MarketLens</title>")
  })
})
