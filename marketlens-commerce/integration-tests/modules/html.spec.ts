// Gabarits auto-échappants : tout le back-office marchand rend du HTML au
// travers de `html`/`rendre`. Si l'échappement par défaut a une faille, elle
// se répercute dans chaque écran — d'où une suite dédiée, avant toute page.
import { html, brut, rendre } from "../../src/lib/html"

describe("Gabarits auto-échappants", () => {
  it("échappe toute interpolation par défaut", () => {
    const hostile = `<script>alert(1)</script>`
    const sortie = rendre(html`<h1>${hostile}</h1>`)
    expect(sortie).not.toContain("<script>")
    expect(sortie).toContain("&lt;script&gt;")
  })

  it("échappe les guillemets et l'esperluette, pas seulement les chevrons", () => {
    // Une valeur interpolée dans un attribut s'échappe d'un attribut par un
    // simple guillemet : `value="${x}"` avec x = `" onfocus="alert(1)`.
    const sortie = rendre(html`<input value="${`" onfocus="alert(1)`}">`)
    expect(sortie).not.toContain(`onfocus="alert(1)"`)
    expect(sortie).toContain("&quot;")
  })

  it("n'échappe pas ce qui est explicitement marqué brut", () => {
    const sortie = rendre(html`<div>${brut("<b>gras</b>")}</div>`)
    expect(sortie).toContain("<b>gras</b>")
  })

  it("compose sans double échappement", () => {
    // Un fragment déjà construit par `html` est du HTML sûr : le réinterpoler
    // ne doit pas transformer ses balises en entités.
    const ligne = html`<li>${"Tomates & co"}</li>`
    const sortie = rendre(html`<ul>${ligne}</ul>`)
    expect(sortie).toBe("<ul><li>Tomates &amp; co</li></ul>")
  })

  it("rend une liste de fragments sans virgules parasites", () => {
    const items = ["a", "b"].map((v) => html`<li>${v}</li>`)
    expect(rendre(html`<ul>${items}</ul>`)).toBe("<ul><li>a</li><li>b</li></ul>")
  })

  it("ne rend pas la chaîne « null » ou « undefined »", () => {
    expect(rendre(html`<p>${null}</p>`)).toBe("<p></p>")
    expect(rendre(html`<p>${undefined}</p>`)).toBe("<p></p>")
  })

  it("n'accepte pas un objet forgé portant une clé « __html » comme HTML sûr", () => {
    // Un corps de requête désérialisé (JSON, ou `qs`/le parseur de formulaire
    // via une notation à crochets comme `champ[__html]=<script>...`) peut
    // produire un objet littéral avec une clé `__html` — ce n'est pas pour
    // autant un fragment produit par `html`/`brut`. Il doit être échappé
    // comme n'importe quelle autre valeur, jamais inséré tel quel.
    const forge = JSON.parse('{"__html":"<script>alert(1)</script>"}')
    const sortie = rendre(html`<div>${forge}</div>`)
    expect(sortie).not.toContain("<script>alert(1)</script>")
    expect(sortie).not.toContain("<script>")
  })
})
