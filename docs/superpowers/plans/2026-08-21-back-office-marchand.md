# Back-office marchand — plan d'implémentation

> **Pour les agents :** SOUS-COMPÉTENCE REQUISE : utiliser
> superpowers:subagent-driven-development (recommandé) ou
> superpowers:executing-plans pour exécuter ce plan tâche par tâche. Les étapes
> utilisent la syntaxe à cases (`- [ ]`) pour le suivi.

**But :** livrer l'écran de la commerçante — se connecter, voir ses catalogues,
photographier, tarifier, publier, dépublier, corriger prix et stocks — pour qu'un
usage réel du produit ne passe plus par `curl`.

**Architecture :** pages HTML rendues par Medusa lui-même sous `/marchand/*`, en
même origine que l'API, avec session par cookie. Gabarits en balises littérales
auto-échappantes, sans dépendance. L'annotation d'image devient un flux
réutilisable appelé par trois chemins : publier, republier, corriger un prix.

**Pile :** Medusa v2.18.0, TypeScript, PostgreSQL 16 (port 5440), Jest via
`@medusajs/test-utils`, service de vision FastAPI (port 8010).

**Spec :** `docs/superpowers/specs/2026-08-21-back-office-marchand-design.md`

## Contraintes globales

Recopiées verbatim de la spec. **Elles s'appliquent à toutes les tâches.** Le lot
précédent a laissé passer une exigence écrite en gras faute de l'avoir recopiée
ici : chaque revue de tâche vérifie cette liste, pas seulement le texte de la tâche.

1. **Refus de toute route et de tout écran pour un marchand dont le statut n'est
   pas `active`** — 403 côté marchand, 404 côté vitrine. Passer par
   `marchandActifOuRefus` ; ne jamais réécrire ce contrôle.
2. **L'identité vient toujours de la session** (`req.auth_context.actor_id`),
   jamais du corps ni de l'URL.
3. **Aucune clé étrangère inter-modules** ; les rattachements passent par
   `defineLink`.
4. **Messages en français**, sans fuite de détail technique. Le détail va au
   journal serveur.
5. **Une panne amont sort en 5xx**, jamais en 4xx accusant la saisie de la
   commerçante.
6. **`--forceExit` interdit** dans les scripts de test — il provoque
   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` et un exit 127 avec
   tous les tests verts.
7. **`npm run typecheck` doit sortir 0.** `@swc/jest` ne vérifie pas les types :
   un test vert ne prouve pas que `tsc` passe.
8. **Tests HTTP en deltas, jamais en zéros absolus** : la base est partagée entre
   fichiers de test.
9. **Une zone peut ne porter aucun produit** : la commerçante ne tarifie pas
   forcément tout ce qui est détecté.
10. **`detected_label` et `product.title` divergent par construction** : décider
    lequel chaque écran affiche.
11. **La base de développement ne contient aucune image annotée exploitable** :
    les 28 catalogues importés du corpus portent un JPEG factice de 6 octets.
    Développer les écrans contre une analyse fraîche.
12. **Quantité par variante** — tranchée en tâche 5, voir la décision D5 ci-dessous.

## Décisions prises dans ce plan

**D5 — La quantité saisie est PAR DÉCLINAISON, et l'écran l'affiche.**
La spec exige que ce plan tranche. Retenu : conserver le comportement actuel
(`quantity` posé sur chaque variante), parce que passer à « un total à répartir »
exigerait de deviner une règle de répartition qu'aucune commerçante n'a demandée.
Mais le silence actuel est le vrai défaut : l'écran de tarification doit libeller
le champ **« Quantité par déclinaison »** et afficher le total calculé en clair —
« 4 par déclinaison × 4 déclinaisons = 16 en stock ». La surprise disparaît sans
qu'on invente une règle.

**D6 — `source_image_id` est ajouté au modèle.**
La régénération d'image doit relire l'image source. `fileModuleService.getAsBuffer(id)`
prend l'identifiant du fichier (vérifié dans
`node_modules/@medusajs/file/dist/services/file-module-service.js:88`), or le
catalogue ne stocke aujourd'hui que `source_image_url`. Déduire l'identifiant de
l'URL marcherait avec le fournisseur local et casserait avec S3. La colonne est
donc ajoutée, **nullable** : les catalogues déjà en base (28 du corpus, plus ceux
des démonstrations) ne l'ont pas, et leur correction de prix doit échouer
proprement plutôt que planter.

---

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `src/lib/html.ts` | **Créer.** Balise littérale auto-échappante `html` + `brut()`. Une seule responsabilité : produire du HTML sûr. |
| `src/lib/pages/layout.ts` | **Créer.** Gabarit commun : en-tête, navigation, pied, styles. |
| `src/api/marchand/garde.ts` | **Créer.** Garde d'accès des pages : session → marchand actif, ou redirection vers la connexion. |
| `src/api/marchand/connexion/route.ts` | **Créer.** GET (formulaire) et POST (connexion/inscription, pose le cookie). |
| `src/api/marchand/deconnexion/route.ts` | **Créer.** POST : détruit la session. |
| `src/api/marchand/route.ts` | **Créer.** Liste des catalogues. |
| `src/api/marchand/nouveau/route.ts` | **Créer.** Prise de photo et affichage des zones. |
| `src/api/marchand/catalogues/[id]/route.ts` | **Créer.** Tarification et publication d'un brouillon. |
| `src/api/marchand/catalogues/[id]/prix/route.ts` | **Créer.** Correction des prix et stocks. |
| `src/api/merchant/catalogues/[id]/route.ts` | **Créer.** `GET` détail JSON avec zones et produits. |
| `src/api/merchant/catalogues/[id]/unpublish/route.ts` | **Créer.** |
| `src/api/merchant/catalogues/[id]/republish/route.ts` | **Créer.** |
| `src/api/merchant/catalogues/[id]/items/route.ts` | **Créer.** `PATCH` prix et quantités. |
| `src/workflows/annoter-catalogue.ts` | **Créer.** Flux réutilisable : lit l'image source, annote, dépose, met à jour `annotated_image_url`. |
| `src/modules/visual-catalog/models/visual-catalogue.ts` | **Modifier.** Ajouter `source_image_id`. |
| `src/workflows/analyze-catalogue-photo.ts` | **Modifier.** Persister `source_image_id`. |
| `src/api/c/[handle]/route.ts` | **Modifier.** Afficher les prix lus dans Medusa. |

---

## Tâche 1 : Gabarits auto-échappants

**Fichiers :**
- Créer : `marketlens-commerce/src/lib/html.ts`
- Créer : `marketlens-commerce/src/lib/pages/layout.ts`
- Test : `marketlens-commerce/integration-tests/modules/html.spec.ts`

**Interfaces :**
- Produit : `html(chaines: TemplateStringsArray, ...valeurs: unknown[]): HtmlSur`,
  `brut(s: string): HtmlSur`, `type HtmlSur = { readonly __html: string }`,
  `rendre(h: HtmlSur): string`
- Produit : `page(options: { titre: string; marchand?: string; corps: HtmlSur }): string`

- [ ] **Étape 1 : écrire le test qui échoue**

```typescript
// integration-tests/modules/html.spec.ts
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
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Lancer : `cd marketlens-commerce && npx jest integration-tests/modules/html.spec.ts`
Attendu : ÉCHEC — `Cannot find module '../../src/lib/html'`

- [ ] **Étape 3 : implémenter le minimum**

```typescript
// src/lib/html.ts

/** Marqueur de HTML déjà sûr. Le champ est `readonly` et le type n'est pas
 *  exporté comme constructible : la seule façon d'en obtenir un est `html` ou
 *  `brut`, ce qui rend l'échappement non contournable par accident. */
export type HtmlSur = { readonly __html: string }

const ENTITES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

/** Les guillemets et l'apostrophe comptent autant que les chevrons : une valeur
 *  interpolée dans un attribut s'en échappe sans jamais ouvrir de balise. */
function echapper(valeur: string): string {
  return valeur.replace(/[&<>"']/g, (c) => ENTITES[c])
}

function estSur(v: unknown): v is HtmlSur {
  return typeof v === "object" && v !== null && "__html" in v
}

function convertir(valeur: unknown): string {
  if (valeur === null || valeur === undefined || valeur === false) return ""
  if (estSur(valeur)) return valeur.__html
  if (Array.isArray(valeur)) return valeur.map(convertir).join("")
  return echapper(String(valeur))
}

export function html(
  chaines: TemplateStringsArray,
  ...valeurs: unknown[]
): HtmlSur {
  let sortie = chaines[0]
  for (let i = 0; i < valeurs.length; i++) {
    sortie += convertir(valeurs[i]) + chaines[i + 1]
  }
  return { __html: sortie }
}

/** Insère du HTML sans l'échapper. À n'utiliser que sur du contenu dont
 *  l'origine est le code de ce dépôt — jamais sur une valeur venue de la base,
 *  d'un formulaire ou d'un service amont. */
export function brut(s: string): HtmlSur {
  return { __html: s }
}

export function rendre(h: HtmlSur): string {
  return h.__html
}
```

- [ ] **Étape 4 : lancer le test et vérifier qu'il passe**

Lancer : `cd marketlens-commerce && npx jest integration-tests/modules/html.spec.ts`
Attendu : SUCCÈS, 6 tests

- [ ] **Étape 5 : écrire le gabarit commun**

```typescript
// src/lib/pages/layout.ts
import { HtmlSur, brut, html, rendre } from "../html"

// Les styles sont du contenu de ce dépôt, jamais une donnée : `brut` est
// justifié ici et nulle part ailleurs dans ce fichier.
const STYLES = `
:root{--fond:#0f1115;--carte:#171a21;--bord:#262b36;--texte:#e8eaed;
  --doux:#9aa3b2;--accent:#ff8a3d;--ok:#3ddc97;--err:#ff5c6c}
*{box-sizing:border-box}
body{margin:0;background:var(--fond);color:var(--texte);
  font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{border-bottom:1px solid var(--bord);padding:16px 20px;
  display:flex;align-items:center;justify-content:space-between;gap:12px}
header a{color:var(--texte);text-decoration:none;font-weight:650}
header .qui{color:var(--doux);font-size:13.5px}
main{max-width:820px;margin:0 auto;padding:22px 20px 70px}
h1{font-size:21px;margin:0 0 4px}
.sous{color:var(--doux);font-size:14px;margin:0 0 20px}
.carte{background:var(--carte);border:1px solid var(--bord);
  border-radius:11px;padding:16px 18px;margin-bottom:12px}
label{display:block;font-size:12.5px;color:var(--doux);margin:12px 0 5px}
input,select{width:100%;padding:11px 12px;background:#0e1016;color:var(--texte);
  border:1px solid var(--bord);border-radius:8px;font:inherit}
button{margin-top:16px;padding:12px 20px;background:var(--accent);color:#2b1200;
  border:0;border-radius:8px;font:inherit;font-weight:650;cursor:pointer}
button.sec{background:transparent;color:var(--doux);border:1px solid var(--bord)}
.err{background:#2a1216;color:var(--err);border:1px solid #4a1f27;
  padding:11px 13px;border-radius:8px;margin-bottom:14px}
.ok{background:#0f2a20;color:var(--ok);border:1px solid #1c4636;
  padding:11px 13px;border-radius:8px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--doux);font-size:11.5px;text-transform:uppercase;
  letter-spacing:.05em;padding:0 8px 7px;font-weight:500}
td{padding:6px 8px;border-top:1px solid var(--bord)}
img{max-width:100%;border-radius:9px;display:block}
a.lien{color:var(--accent)}
`

/** Un seul gabarit pour toutes les pages du back-office. Le titre et le nom de
 *  la boutique passent par `html`, donc sont échappés : un nom de boutique
 *  hostile ne peut pas s'évader de l'en-tête. */
export function page(options: {
  titre: string
  marchand?: string
  corps: HtmlSur
}): string {
  const entete = options.marchand
    ? html`<header>
        <a href="/marchand">MarketLens</a>
        <span class="qui">${options.marchand} ·
          <a class="lien" href="/marchand/deconnexion?action=sortir">Se déconnecter</a>
        </span>
      </header>`
    : html`<header><a href="/marchand">MarketLens</a></header>`

  return (
    "<!doctype html>" +
    rendre(html`<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${options.titre} — MarketLens</title>
<style>${brut(STYLES)}</style></head><body>${entete}<main>${options.corps}</main></body></html>`)
  )
}
```

- [ ] **Étape 6 : vérifier le typage et l'ensemble des tests de module**

Lancer : `cd marketlens-commerce && npm run test:integration:modules`
Attendu : typecheck 0, toutes les suites vertes

- [ ] **Étape 7 : commiter**

```bash
git add marketlens-commerce/src/lib/html.ts marketlens-commerce/src/lib/pages/layout.ts \
        marketlens-commerce/integration-tests/modules/html.spec.ts
git commit -m "feat(commerce): pose des gabarits qui echappent par defaut"
```

---

## Tâche 2 : Session et écran de connexion

**Fichiers :**
- Créer : `marketlens-commerce/src/api/marchand/garde.ts`
- Créer : `marketlens-commerce/src/api/marchand/connexion/route.ts`
- Créer : `marketlens-commerce/src/api/marchand/deconnexion/route.ts`
- Modifier : `marketlens-commerce/src/api/middlewares.ts`
- Test : `marketlens-commerce/integration-tests/http/back-office-acces.spec.ts`

**Interfaces :**
- Consomme : `marchandActifOuRefus(container, merchantId, etiquette)` et
  `ControleMarchand` de `src/api/merchant/catalogues/scope.ts`
- Produit : `pageMarchandOuRedirection(req, res, etiquette): Promise<Marchand | null>`
  — rend le marchand si l'accès est permis, sinon écrit la redirection et rend `null`.
  L'appelant doit sortir immédiatement sur `null`.

**Contexte que la tâche ne peut pas deviner :**
`src/api/middlewares.ts` déclare déjà `authenticate("merchant", ["session", "bearer"])`
sur les routes `/merchant/*`. Les pages `/marchand/*` ont besoin du même
traitement, mais avec `allowUnregistered: true` sur l'écran de connexion, et
surtout **sans renvoyer un 401 JSON** : une page doit rediriger, pas rendre un
objet d'erreur. Le motif de matcher existant est
`/^\/merchant(?:\/(?!register\/?$).*)?$/i` — le drapeau `i` y est essentiel et a
déjà corrigé un contournement d'authentification complet ; ne pas l'oublier sur
le nouveau motif.

`POST /auth/session` (vérifié dans
`node_modules/@medusajs/medusa/dist/api/auth/session/route.js`) copie
`req.auth_context` dans `req.session` et accepte **tout type d'acteur**. Le
back-office s'en sert plutôt que de réimplémenter une session.

- [ ] **Étape 1 : écrire le test qui échoue**

```typescript
// integration-tests/http/back-office-acces.spec.ts
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { MERCHANT_MODULE } from "../../src/modules/merchant"

jest.setTimeout(120000)

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Accès au back-office", () => {
      it("redirige vers la connexion quand aucune session n'est ouverte", async () => {
        const r = await api
          .get("/marchand", { maxRedirects: 0, validateStatus: () => true })
        expect(r.status).toBe(302)
        expect(r.headers.location).toBe("/marchand/connexion")
      })

      it("sert la liste après connexion, et le nom de la boutique y figure échappé", async () => {
        const email = "garde@marketlens.test"
        const insc = await api.post("/auth/merchant/emailpass/register", {
          email, password: "motdepasse-de-test",
        })
        await api.post(
          "/merchant/register",
          { name: `Étal <b>Aïcha</b>`, handle: "etal-garde", phone: "22990000061" },
          { headers: { authorization: `Bearer ${insc.data.token}` } }
        )
        const conn = await api.post("/auth/merchant/emailpass", {
          email, password: "motdepasse-de-test",
        })
        // POST /auth/session échange le jeton contre un cookie.
        const session = await api.post("/auth/session", {}, {
          headers: { authorization: `Bearer ${conn.data.token}` },
        })
        const cookie = session.headers["set-cookie"]!.join("; ")

        const page = await api.get("/marchand", { headers: { cookie } })
        expect(page.status).toBe(200)
        expect(page.headers["content-type"]).toContain("text/html")
        // Le nom hostile ressort échappé : c'est la garantie qui compte.
        expect(page.data).toContain("&lt;b&gt;Aïcha&lt;/b&gt;")
        expect(page.data).not.toContain("<b>Aïcha</b>")
      })

      it("renvoie un marchand suspendu vers la connexion, sans rien lui servir", async () => {
        const email = "suspendu-bo@marketlens.test"
        const insc = await api.post("/auth/merchant/emailpass/register", {
          email, password: "motdepasse-de-test",
        })
        const creation = await api.post(
          "/merchant/register",
          { name: "Étal suspendu", handle: "etal-bo-suspendu", phone: "22990000062" },
          { headers: { authorization: `Bearer ${insc.data.token}` } }
        )
        const conn = await api.post("/auth/merchant/emailpass", {
          email, password: "motdepasse-de-test",
        })
        const session = await api.post("/auth/session", {}, {
          headers: { authorization: `Bearer ${conn.data.token}` },
        })
        const cookie = session.headers["set-cookie"]!.join("; ")

        const service: any = getContainer().resolve(MERCHANT_MODULE)
        await service.updateMerchants({
          id: creation.data.merchant.id, status: "suspended",
        })

        const page = await api
          .get("/marchand", { headers: { cookie }, maxRedirects: 0, validateStatus: () => true })
        expect(page.status).toBe(302)
        expect(page.headers.location).toBe("/marchand/connexion?erreur=inactif")
        expect(page.data).not.toContain("Étal suspendu")
      })
    })
  },
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Lancer : `cd marketlens-commerce && TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand integration-tests/http/back-office-acces.spec.ts`
Attendu : ÉCHEC — 404 au lieu de 302, les routes n'existent pas

- [ ] **Étape 3 : implémenter la garde**

```typescript
// src/api/marchand/garde.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Marchand, marchandActifOuRefus } from "../merchant/catalogues/scope"

// `Marchand` n'est PAS redéfini ici : une seconde définition divergerait de
// celle de scope.ts sans que rien ne le signale. Si scope.ts ne l'exporte pas
// encore, l'exporter plutôt que le recopier.

/**
 * Garde d'accès des PAGES du back-office. Elle applique exactement le même
 * contrôle que les routes JSON — `marchandActifOuRefus`, point de décision
 * unique — mais traduit le refus en redirection : rendre un 401 JSON à un
 * navigateur laisserait la commerçante devant un objet d'erreur.
 *
 * Rend `null` quand l'accès est refusé, APRÈS avoir écrit la redirection :
 * l'appelant doit sortir immédiatement.
 */
export async function pageMarchandOuRedirection(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
  etiquette: string
): Promise<Marchand | null> {
  const controle = await marchandActifOuRefus(
    req.scope,
    req.auth_context?.actor_id,
    etiquette
  )
  if (!controle.autorise) {
    // Le motif est distingué pour que l'écran de connexion puisse dire quelque
    // chose d'utile, mais jamais nommer la boutique ni le catalogue.
    const suffixe = controle.statut === 403 ? "?erreur=inactif" : ""
    res.redirect(302, `/marchand/connexion${suffixe}`)
    return null
  }
  return controle.marchand
}
```

- [ ] **Étape 4 : implémenter l'écran de connexion**

```typescript
// src/api/marchand/connexion/route.ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { html } from "../../../lib/html"
import { page } from "../../../lib/pages/layout"

const MESSAGES: Record<string, string> = {
  inactif: "Votre compte n'est pas actif. Contactez l'équipe MarketLens.",
  identifiants: "Adresse ou mot de passe incorrect.",
  session: "Votre session a expiré. Reconnectez-vous.",
}

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const cle = String(req.query.erreur ?? "")
  const message = MESSAGES[cle]

  const corps = html`
    ${message ? html`<div class="err">${message}</div>` : null}
    <h1>Se connecter</h1>
    <p class="sous">Votre boutique MarketLens.</p>
    <form class="carte" method="post" action="/marchand/connexion">
      <label for="email">Adresse e-mail</label>
      <input id="email" name="email" type="email" required autocomplete="username">
      <label for="motdepasse">Mot de passe</label>
      <input id="motdepasse" name="motdepasse" type="password" required
             autocomplete="current-password">
      <button type="submit">Entrer</button>
    </form>`

  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.send(page({ titre: "Connexion", corps }))
}
```

Le `POST` de connexion appelle les routes d'authentification du framework en
interne plutôt que de réimplémenter la vérification du mot de passe. Le code
complet est donné à l'étape 5.

- [ ] **Étape 5 : implémenter la connexion (POST) et la déconnexion**

```typescript
// suite de src/api/marchand/connexion/route.ts
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const { email, motdepasse } = (req.body ?? {}) as Record<string, string>

  if (!email || !motdepasse) {
    return res.redirect(302, "/marchand/connexion?erreur=identifiants")
  }

  const authModule: any = req.scope.resolve("auth")
  const resultat = await authModule.authenticate("emailpass", {
    body: { email, password: motdepasse },
    authScope: "merchant",
    protocol: "http",
    url: "/auth/merchant/emailpass",
    headers: {},
    query: {},
  })

  if (!resultat.success || !resultat.authIdentity) {
    // Le détail technique va au journal ; la commerçante reçoit un message
    // unique, qui ne dit pas si c'est l'adresse ou le mot de passe qui cloche.
    logger.warn(`Connexion refusée pour ${email} : ${resultat.error ?? "inconnue"}`)
    return res.redirect(302, "/marchand/connexion?erreur=identifiants")
  }

  // La session porte le contexte d'authentification, exactement comme le fait
  // POST /auth/session du framework.
  ;(req as any).session.auth_context = {
    actor_id: resultat.authIdentity.app_metadata?.merchant_id,
    actor_type: "merchant",
    auth_identity_id: resultat.authIdentity.id,
    app_metadata: resultat.authIdentity.app_metadata,
  }

  res.redirect(302, "/marchand")
}
```

```typescript
// src/api/marchand/deconnexion/route.ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

const terminer = async (req: MedusaRequest, res: MedusaResponse) => {
  await new Promise<void>((resoudre) => {
    ;(req as any).session?.destroy(() => resoudre())
  })
  res.redirect(302, "/marchand/connexion")
}

export const POST = terminer
// Le lien « Se déconnecter » de l'en-tête est un GET : sans cette route, il
// tomberait sur un 404 et la commerçante resterait connectée en croyant
// être sortie.
export const GET = terminer
```

- [ ] **Étape 6 : déclarer les intergiciels**

Dans `src/api/middlewares.ts`, ajouter aux `routes` existantes, **avant** la règle
générale `/merchant` :

```typescript
    {
      // L'écran de connexion doit être atteignable sans session.
      matcher: /^\/marchand\/(connexion|deconnexion)\/?$/i,
      middlewares: [
        authenticate("merchant", ["session", "bearer"], { allowUnregistered: true }),
      ],
    },
    {
      // Le drapeau `i` est indispensable : sans lui, /Marchand contourne
      // entièrement l'authentification. Ce défaut exact a déjà été livré une
      // fois sur /merchant.
      matcher: /^\/marchand(?:\/(?!connexion\/?$|deconnexion\/?$).*)?$/i,
      middlewares: [
        authenticate("merchant", ["session", "bearer"], { allowUnregistered: true }),
      ],
    },
```

`allowUnregistered: true` est délibéré sur les deux : l'intergiciel ne doit
jamais rendre un 401 JSON à un navigateur. C'est `pageMarchandOuRedirection` qui
refuse, en redirigeant.

- [ ] **Étape 7 : implémenter la page liste minimale pour rendre le test vert**

```typescript
// src/api/marchand/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { html } from "../../lib/html"
import { page } from "../../lib/pages/layout"
import { pageMarchandOuRedirection } from "./garde"
import { cataloguesDuMarchand } from "../merchant/catalogues/scope"

export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const marchand = await pageMarchandOuRedirection(req, res, "GET /marchand")
  if (!marchand) return

  const catalogues = await cataloguesDuMarchand(req.scope, marchand.id)
  const brouillons = catalogues.filter((c) => c.status !== "published")
  const publies = catalogues.filter((c) => c.status === "published")

  const carte = (c: (typeof catalogues)[number], publie: boolean) => html`
    <div class="carte">
      <b>${c.title}</b>
      <div class="sous" style="margin:4px 0 0">
        ${publie
          ? html`En ligne · <a class="lien" href="/c/${c.handle}">voir la vitrine</a>`
          : "Brouillon — prix à saisir"}
      </div>
      <a class="lien" href="/marchand/catalogues/${c.id}${publie ? "/prix" : ""}">
        ${publie ? "Corriger les prix" : "Terminer et publier"}
      </a>
    </div>`

  const corps = html`
    <h1>Mes catalogues</h1>
    <p class="sous">${marchand.name}</p>
    <a href="/marchand/nouveau"><button>Photographier mon étal</button></a>
    ${brouillons.length ? html`<h2>À terminer</h2>` : null}
    ${brouillons.map((c) => carte(c, false))}
    ${publies.length ? html`<h2>En ligne</h2>` : null}
    ${publies.map((c) => carte(c, true))}
    ${catalogues.length === 0
      ? html`<div class="carte">Aucun catalogue pour l'instant.</div>`
      : null}`

  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.send(page({ titre: "Mes catalogues", marchand: marchand.name, corps }))
}
```

- [ ] **Étape 8 : lancer le test et vérifier qu'il passe**

Lancer : `cd marketlens-commerce && TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand integration-tests/http/back-office-acces.spec.ts`
Attendu : SUCCÈS, 3 tests

- [ ] **Étape 9 : vérifier ROUGE chaque garde de sécurité**

Règle héritée du lot précédent : *un test qui passe du premier coup ne prouve
rien.* Pour chacune des deux gardes, retirer la garde, constater l'échec,
restaurer :

1. Dans `garde.ts`, remplacer le `if (!controle.autorise)` par `if (false)`.
   Relancer : le test « marchand suspendu » DOIT échouer (200 au lieu de 302).
   Restaurer.
2. Dans `middlewares.ts`, retirer le drapeau `i` du second matcher. Ajouter une
   assertion temporaire appelant `/Marchand` en majuscule : elle DOIT servir la
   page sans session. Restaurer le drapeau et retirer l'assertion temporaire.

Coller les deux sorties rouges dans le rapport de tâche.

- [ ] **Étape 10 : commiter**

```bash
git add marketlens-commerce/src/api/marchand marketlens-commerce/src/api/middlewares.ts \
        marketlens-commerce/integration-tests/http/back-office-acces.spec.ts
git commit -m "feat(commerce): ouvre le back-office marchand par session cookie"
```

---

## Tâche 3 : Détail d'un catalogue (API) et enrichissement de la liste

**Fichiers :**
- Créer : `marketlens-commerce/src/api/merchant/catalogues/[id]/route.ts`
- Modifier : `marketlens-commerce/src/api/merchant/catalogues/scope.ts`
- Test : `marketlens-commerce/integration-tests/http/catalogue-detail.spec.ts`

**Interfaces :**
- Consomme : `catalogueDuMarchand(container, merchantId, catalogueId)` de `scope.ts`
- Produit : `detailCatalogueDuMarchand(container, merchantId, catalogueId): Promise<DetailCatalogue | null>`
  avec
  ```typescript
  export type ZoneDetail = {
    id: string
    x: number; y: number; width: number; height: number
    detected_label: string
    detected_category: string | null
    product: {
      id: string
      title: string
      variants: { id: string; title: string; prix: number | null }[]
    } | null
  }
  export type DetailCatalogue = {
    id: string; handle: string; title: string; status: string
    source_image_url: string
    annotated_image_url: string | null
    zones: ZoneDetail[]
  }
  ```

**Pourquoi cette tâche existe :** `cataloguesDuMarchand` ne rend pas les zones, et
aucune route ne rend le détail d'un catalogue. Sans elle, les écrans de
tarification et de correction des prix n'ont rien à afficher.

**Piège à connaître :** le lien marchand→catalogue est déclaré `isList: true`, donc
le champ inverse est **singulier** (`merchant`). Le pluriel est accepté par
`query.graph` sans erreur mais ne renvoie rien du tout — vérifié contre cette base.
De même, le champ produit d'une zone est singulier (`zones.product`).

- [ ] **Étape 1 : écrire le test qui échoue**

```typescript
// integration-tests/http/catalogue-detail.spec.ts — extrait significatif
it("rend le détail avec ses zones, et refuse le catalogue d'un autre marchand", async () => {
  const yaa = await inscrireEtAnalyser(api, "etal-detail-yaa", "22990000071")
  const kwame = await inscrireEtAnalyser(api, "etal-detail-kwame", "22990000072")

  const detail = await api.get(`/merchant/catalogues/${yaa.catalogueId}`, {
    headers: { authorization: `Bearer ${yaa.jeton}` },
  })
  expect(detail.status).toBe(200)
  expect(detail.data.catalogue.zones.length).toBeGreaterThan(0)
  expect(detail.data.catalogue.zones[0].detected_label).toBeTruthy()
  // Un brouillon n'a pas encore de produit : le champ existe et vaut null.
  expect(detail.data.catalogue.zones[0].product).toBeNull()

  // Le catalogue d'autrui est INTROUVABLE, pas interdit : un 403 confirmerait
  // son existence à qui ne devrait pas la connaître.
  const vol = await api
    .get(`/merchant/catalogues/${yaa.catalogueId}`, {
      headers: { authorization: `Bearer ${kwame.jeton}` },
    })
    .catch((e: any) => e.response)
  expect(vol.status).toBe(404)
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Lancer : `TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand integration-tests/http/catalogue-detail.spec.ts`
Attendu : ÉCHEC — 404 sur le premier appel, la route n'existe pas

- [ ] **Étape 3 : implémenter `detailCatalogueDuMarchand` dans `scope.ts`**

```typescript
// ajout à src/api/merchant/catalogues/scope.ts
export async function detailCatalogueDuMarchand(
  container: MedusaContainer,
  merchantId: string,
  catalogueId: string
): Promise<DetailCatalogue | null> {
  // Le contrôle d'appartenance passe par l'assistant existant : il est le seul
  // endroit qui décide qui voit quoi, et il rend `null` aussi bien pour un
  // catalogue inexistant que pour celui d'un autre marchand.
  const possede = await catalogueDuMarchand(container, merchantId, catalogueId)
  if (!possede) return null

  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "visual_catalogue",
    fields: [
      "id", "handle", "title", "status",
      "source_image_url", "annotated_image_url",
      "zones.id", "zones.x", "zones.y", "zones.width", "zones.height",
      "zones.detected_label", "zones.detected_category",
      // Champ SINGULIER : une zone porte au plus un produit publié.
      "zones.product.id", "zones.product.title",
      "zones.product.variants.id", "zones.product.variants.title",
      "zones.product.variants.prices.amount",
      "zones.product.variants.prices.currency_code",
    ],
    filters: { id: catalogueId },
  })

  const c = data[0] as any
  if (!c) return null

  return {
    id: c.id, handle: c.handle, title: c.title, status: c.status,
    source_image_url: c.source_image_url,
    annotated_image_url: c.annotated_image_url ?? null,
    zones: (c.zones ?? []).map((z: any) => ({
      id: z.id, x: z.x, y: z.y, width: z.width, height: z.height,
      detected_label: z.detected_label,
      detected_category: z.detected_category ?? null,
      product: z.product
        ? {
            id: z.product.id,
            title: z.product.title,
            variants: (z.product.variants ?? []).map((v: any) => ({
              id: v.id,
              title: v.title,
              prix: prixXof(v.prices),
            })),
          }
        : null,
    })),
  }
}

/** Lecture directe du prix posé, sans contexte de prix calculé. Juste tant
 *  qu'il n'y a qu'une devise et aucune liste de prix — limite assumée, notée
 *  R2 dans la spec. */
function prixXof(prix: { amount: number; currency_code: string }[] | undefined) {
  return prix?.find((p) => p.currency_code === "xof")?.amount ?? null
}
```

- [ ] **Étape 4 : implémenter la route**

```typescript
// src/api/merchant/catalogues/[id]/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { marchandActifOuRefus, detailCatalogueDuMarchand, etiquetteJournal } from "../scope"

export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const controle = await marchandActifOuRefus(
    req.scope,
    req.auth_context?.actor_id,
    etiquetteJournal("GET /merchant/catalogues/:id", req)
  )
  if (!controle.autorise) {
    return res.status(controle.statut).json({ message: controle.message })
  }

  const detail = await detailCatalogueDuMarchand(
    req.scope, controle.marchand.id, req.params.id
  )
  if (!detail) {
    return res.status(404).json({ message: "Catalogue introuvable" })
  }
  res.json({ catalogue: detail })
}
```

- [ ] **Étape 5 : lancer le test et vérifier qu'il passe**

Lancer : `TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand integration-tests/http/catalogue-detail.spec.ts`
Attendu : SUCCÈS

- [ ] **Étape 6 : commiter**

```bash
git add marketlens-commerce/src/api/merchant/catalogues marketlens-commerce/integration-tests/http/catalogue-detail.spec.ts
git commit -m "feat(commerce): rend le detail d'un catalogue avec ses zones"
```

---

## Tâche 4 : Écran « photographier mon étal »

**Fichiers :**
- Créer : `marketlens-commerce/src/api/marchand/nouveau/route.ts`
- Test : `marketlens-commerce/integration-tests/http/back-office-nouveau.spec.ts`

**Interfaces :**
- Consomme : `pageMarchandOuRedirection` (tâche 2), `page` et `html` (tâche 1)
- Consomme : `POST /merchant/catalogues` (existant, multipart, champs `image` et `title`)

**Contexte :** l'envoi se fait en JavaScript depuis la page vers l'API existante,
plutôt qu'en `<form enctype="multipart/form-data">` classique : il faut afficher
les zones détectées **par-dessus l'aperçu de la photo**, ce qu'un rechargement de
page complet rendrait maladroit. La page de démonstration
`src/api/demo/page.html` contient déjà ce dessin de zones en pourcentages —
s'en inspirer, sans la copier verbatim.

L'attribut `capture="environment"` sur le champ fichier ouvre directement
l'appareil photo arrière sur mobile. C'est le geste réel de la commerçante.

- [ ] **Étape 1 : écrire le test qui échoue**

```typescript
it("sert l'écran de prise de photo à une commerçante connectée", async () => {
  const cookie = await connecter(api, "etal-nouveau", "22990000081")
  const p = await api.get("/marchand/nouveau", { headers: { cookie } })
  expect(p.status).toBe(200)
  expect(p.data).toContain('capture="environment"')
  // La limite doit être annoncée AVANT l'envoi, pas découverte après.
  expect(p.data).toContain("18")
})

it("redirige un visiteur sans session", async () => {
  const p = await api.get("/marchand/nouveau", {
    maxRedirects: 0, validateStatus: () => true,
  })
  expect(p.status).toBe(302)
  expect(p.headers.location).toBe("/marchand/connexion")
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Lancer : `TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand integration-tests/http/back-office-nouveau.spec.ts`
Attendu : ÉCHEC — 404

- [ ] **Étape 3 : implémenter l'écran**

```typescript
// src/api/marchand/nouveau/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { brut, html } from "../../../lib/html"
import { page } from "../../../lib/pages/layout"
import { pageMarchandOuRedirection } from "../garde"
import { TAILLE_MAX_IMAGE_MO } from "../../../lib/limites-image"

const SCRIPT = `
const $ = (i) => document.getElementById(i)
$("photo").onchange = () => {
  const f = $("photo").files[0]; if (!f) return
  $("apercu").src = URL.createObjectURL(f)
  $("scene").style.display = "block"
  document.querySelectorAll(".zone").forEach(z => z.remove())
}
$("envoyer").onclick = async () => {
  const f = $("photo").files[0]
  if (!f) { $("msg").className = "err"; $("msg").textContent = "Choisissez une photo."; return }
  $("envoyer").disabled = true
  $("msg").className = "ok"; $("msg").textContent = "Analyse de la photo en cours…"
  const fd = new FormData()
  fd.append("image", f); fd.append("title", $("titre").value.trim())
  const r = await fetch("/merchant/catalogues", { method: "POST", body: fd })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) {
    $("msg").className = "err"
    $("msg").textContent = d.message || "L'analyse a échoué. Réessayez."
    $("envoyer").disabled = false
    return
  }
  for (const z of d.zones) {
    const e = document.createElement("div")
    e.className = "zone"
    e.style.cssText = "position:absolute;border:2px solid #ff8a3d;border-radius:3px;"
      + "background:rgba(255,138,61,.11);left:" + (z.x/10) + "%;top:" + (z.y/10)
      + "%;width:" + (z.width/10) + "%;height:" + (z.height/10) + "%"
    const b = document.createElement("b")
    b.style.cssText = "position:absolute;top:-1px;left:-1px;background:#ff8a3d;"
      + "color:#2b1200;font:600 11px/1.5 sans-serif;padding:1px 6px;border-radius:3px 0 3px 0"
    b.textContent = z.detected_label
    e.appendChild(b); $("scene").appendChild(e)
  }
  $("msg").className = "ok"
  $("msg").textContent = d.zones.length + " produit(s) reconnu(s). Passez aux prix."
  $("suite").href = "/marchand/catalogues/" + d.catalogue.id
  $("suite").style.display = "inline-block"
}
`

export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const marchand = await pageMarchandOuRedirection(req, res, "GET /marchand/nouveau")
  if (!marchand) return

  const corps = html`
    <h1>Photographier mon étal</h1>
    <p class="sous">Prenez la photo comme vous la montreriez à un client.</p>
    <div class="carte">
      <label for="titre">Nom de ce catalogue</label>
      <input id="titre" value="Étal du jour">
      <label for="photo">Photo</label>
      <input id="photo" type="file" accept="image/jpeg,image/png,image/webp"
             capture="environment">
      <div class="sous" style="margin-top:6px">
        JPEG, PNG ou WebP, moins de ${TAILLE_MAX_IMAGE_MO} Mo.
      </div>
      <button id="envoyer">Analyser la photo</button>
      <a id="suite" href="#" style="display:none;margin-left:10px">
        <button class="sec">Passer aux prix</button>
      </a>
      <div id="msg" style="margin-top:14px"></div>
      <div id="scene" style="position:relative;display:none;margin-top:14px">
        <img id="apercu" alt="">
      </div>
    </div>
    <script>${brut(SCRIPT)}</script>`

  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.send(page({ titre: "Nouveau catalogue", marchand: marchand.name, corps }))
}
```

- [ ] **Étape 4 : lancer le test et vérifier qu'il passe**

Lancer : `TEST_TYPE=integration:http NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand integration-tests/http/back-office-nouveau.spec.ts`
Attendu : SUCCÈS, 2 tests

- [ ] **Étape 5 : commiter**

```bash
git add marketlens-commerce/src/api/marchand/nouveau marketlens-commerce/integration-tests/http/back-office-nouveau.spec.ts
git commit -m "feat(commerce): ecran de prise de photo de l'etal"
```

---

## Tâche 5 : Écran de tarification et publication

**Fichiers :**
- Créer : `marketlens-commerce/src/api/marchand/catalogues/[id]/route.ts`
- Test : `marketlens-commerce/integration-tests/http/back-office-tarification.spec.ts`

**Interfaces :**
- Consomme : `detailCatalogueDuMarchand` (tâche 3), `pageMarchandOuRedirection` (tâche 2)
- Consomme : `POST /merchant/catalogues/:id/publish` (existant), corps
  `{ items: [{ zone_id, label, price, quantity, colors, sizes }] }`

**Décision D5 à appliquer ici.** Le champ quantité est libellé **« Quantité par
déclinaison »**, et la page affiche le total calculé en clair sous la ligne :
`4 par déclinaison × 4 déclinaisons = 16 en stock`. Le total se met à jour quand
la commerçante modifie les couleurs ou les tailles. Sans cet affichage, « 4 pagnes,
2 couleurs, 2 tailles » pose 16 unités en stock sans que personne ne l'ait décidé.

**Rappel de contrainte 9 :** une zone peut ne pas être mise en vente. Chaque ligne
porte une case à cocher, décochée retire la zone de `items`.

**Rappel de contrainte 10 :** l'écran pré-remplit le libellé avec
`detected_label` mais la commerçante le modifie ; c'est sa valeur qui devient
`product.title`. `detected_label` reste affiché en petit, en dessous, comme
rappel de ce que l'IA avait vu.

- [ ] **Étape 1 : écrire le test qui échoue**

```typescript
it("affiche une ligne par zone, avec le libellé détecté pré-rempli", async () => {
  const { cookie, catalogueId, zones } = await connecterEtAnalyser(
    api, "etal-tarif", "22990000091"
  )
  const p = await api.get(`/marchand/catalogues/${catalogueId}`, { headers: { cookie } })
  expect(p.status).toBe(200)
  for (const z of zones) {
    expect(p.data).toContain(z.detected_label)
    expect(p.data).toContain(z.id)
  }
  // D5 : le total doit être annoncé, pas subi.
  expect(p.data).toContain("Quantité par déclinaison")
})

it("ne sert pas le catalogue d'une autre commerçante", async () => {
  const a = await connecterEtAnalyser(api, "etal-tarif-a", "22990000092")
  const b = await connecterEtAnalyser(api, "etal-tarif-b", "22990000093")
  const p = await api.get(`/marchand/catalogues/${a.catalogueId}`, {
    headers: { cookie: b.cookie }, maxRedirects: 0, validateStatus: () => true,
  })
  expect(p.status).toBe(404)
  expect(p.data).not.toContain(a.zones[0].detected_label)
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Attendu : ÉCHEC — 404, la route n'existe pas

- [ ] **Étape 3 : implémenter l'écran**

La page rend un tableau, une ligne par zone. Chaque ligne porte : une case à
cocher (`data-vendre`), le libellé (`data-lib`), le prix (`data-prix`), la
quantité par déclinaison (`data-qte`), les couleurs (`data-coul`) et les tailles
(`data-tail`), plus un `data-zone` portant l'identifiant. Sous chaque ligne, un
`<span data-total>` recalculé à chaque saisie :

```typescript
const SCRIPT = `
const liste = (v) => v.split(",").map(s => s.trim()).filter(Boolean)
function recalculer(tr) {
  const q = Number(tr.querySelector("[data-qte]").value) || 0
  const c = Math.max(1, liste(tr.querySelector("[data-coul]").value).length)
  const t = Math.max(1, liste(tr.querySelector("[data-tail]").value).length)
  const n = c * t
  tr.querySelector("[data-total]").textContent =
    n > 1 ? q + " par déclinaison × " + n + " déclinaisons = " + (q * n) + " en stock"
          : q + " en stock"
}
document.querySelectorAll("tr[data-zone]").forEach(tr => {
  tr.querySelectorAll("input").forEach(i => i.oninput = () => recalculer(tr))
  recalculer(tr)
})
document.getElementById("publier").onclick = async () => {
  const items = []
  for (const tr of document.querySelectorAll("tr[data-zone]")) {
    if (!tr.querySelector("[data-vendre]").checked) continue
    items.push({
      zone_id: tr.dataset.zone,
      label: tr.querySelector("[data-lib]").value.trim(),
      price: tr.querySelector("[data-prix]").value.trim(),
      quantity: Number(tr.querySelector("[data-qte]").value),
      colors: liste(tr.querySelector("[data-coul]").value),
      sizes: liste(tr.querySelector("[data-tail]").value),
    })
  }
  const msg = document.getElementById("msg")
  if (items.length === 0) {
    msg.className = "err"
    msg.textContent = "Cochez au moins un produit à mettre en vente."
    return
  }
  document.getElementById("publier").disabled = true
  msg.className = "ok"; msg.textContent = "Publication en cours…"
  const r = await fetch(location.pathname.replace("/marchand/", "/merchant/") + "/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) {
    msg.className = "err"
    msg.textContent = d.message || "La publication a échoué."
    document.getElementById("publier").disabled = false
    return
  }
  location.href = "/marchand"
}
`
```

```typescript
// src/api/marchand/catalogues/[id]/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { brut, html } from "../../../../lib/html"
import { page, pageIntrouvable } from "../../../../lib/pages/layout"
import { pageMarchandOuRedirection } from "../../garde"
import { detailCatalogueDuMarchand } from "../../../merchant/catalogues/scope"

export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const marchand = await pageMarchandOuRedirection(
    req, res, "GET /marchand/catalogues/:id"
  )
  if (!marchand) return

  const detail = await detailCatalogueDuMarchand(req.scope, marchand.id, req.params.id)
  if (!detail) {
    // Catalogue inexistant et catalogue d'autrui rendent EXACTEMENT la même
    // page : un message distinct confirmerait l'existence du second.
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    return res.status(404).send(pageIntrouvable())
  }
  if (detail.status === "published") {
    return res.redirect(302, `/marchand/catalogues/${detail.id}/prix`)
  }

  const lignes = detail.zones.map(
    (z) => html`
      <tr data-zone="${z.id}">
        <td><input type="checkbox" data-vendre checked style="width:auto"></td>
        <td>
          <input data-lib value="${z.detected_label}">
          <div class="sous" style="margin:3px 0 0">reconnu : ${z.detected_label}</div>
        </td>
        <td><input data-prix value="1000" inputmode="numeric"></td>
        <td><input data-qte value="1" inputmode="numeric"></td>
        <td><input data-coul placeholder="rouge, bleu"></td>
        <td><input data-tail placeholder="M, L"></td>
      </tr>
      <tr><td></td><td colspan="5" class="sous"><span data-total></span></td></tr>`
  )

  const corps = html`
    <h1>${detail.title}</h1>
    <p class="sous">Mettez vos prix, puis publiez.</p>
    ${detail.annotated_image_url
      ? html`<img src="${detail.annotated_image_url}" alt="">`
      : null}
    <div class="carte">
      <table>
        <thead><tr>
          <th style="width:34px">Vendre</th><th>Produit</th><th style="width:110px">Prix (FCFA)</th>
          <th style="width:120px">Quantité par déclinaison</th><th>Couleurs</th><th>Tailles</th>
        </tr></thead>
        <tbody>${lignes}</tbody>
      </table>
      <button id="publier">Publier mon catalogue</button>
      <div id="msg" style="margin-top:14px"></div>
    </div>
    <script>${brut(SCRIPT)}</script>`

  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.send(page({ titre: detail.title, marchand: marchand.name, corps }))
}
```

`pageIntrouvable()` est ajoutée à `src/lib/pages/layout.ts` dans cette tâche :
une page unique, sans nom de boutique ni de catalogue, servie aussi bien pour un
identifiant inexistant que pour le catalogue d'une autre commerçante.

- [ ] **Étape 4 : lancer le test et vérifier qu'il passe**

Attendu : SUCCÈS, 2 tests

- [ ] **Étape 5 : commiter**

```bash
git add marketlens-commerce/src/api/marchand/catalogues marketlens-commerce/integration-tests/http/back-office-tarification.spec.ts
git commit -m "feat(commerce): ecran de tarification, et rend le stock total visible"
```

---

## Tâche 6 : `source_image_id` et flux d'annotation réutilisable

**Fichiers :**
- Modifier : `marketlens-commerce/src/modules/visual-catalog/models/visual-catalogue.ts`
- Créer : migration générée
- Modifier : `marketlens-commerce/src/workflows/analyze-catalogue-photo.ts`
- Créer : `marketlens-commerce/src/workflows/annoter-catalogue.ts`
- Modifier : `marketlens-commerce/src/workflows/publish-catalogue.ts`
- Test : `marketlens-commerce/integration-tests/http/reannotation.spec.ts`

**Interfaces :**
- Produit : `annoterCatalogueWorkflow` prenant
  `{ catalogue_id: string; source_image_id: string; produits: ProduitAnnote[] }`
  et rendant `{ annotated_image_url: string }`
- Produit : `ErreurImageSourceIndisponible` — erreur nommée, `name` posé
  explicitement

**Pourquoi cette tâche est le pivot.** Trois chemins doivent annoter : publier,
republier, corriger un prix. L'annotation est aujourd'hui une étape enfermée dans
le flux de publication, qui reçoit **le contenu de l'image en mémoire** — ce que
seule la publication possède. Les deux autres chemins doivent relire l'image
source depuis le stockage.

`fileModuleService.getAsBuffer(id)` prend l'identifiant du fichier (vérifié dans
`node_modules/@medusajs/file/dist/services/file-module-service.js:88`). Or le
catalogue ne stocke que `source_image_url`. Déduire l'identifiant de l'URL
marcherait avec le fournisseur local et casserait avec S3 : la colonne est donc
ajoutée.

**Elle est nullable, et c'est délibéré :** les catalogues déjà en base (28 du
corpus, plus ceux des démonstrations) ne l'ont pas. Leur correction de prix doit
échouer proprement, avec un message français, plutôt que planter.

- [ ] **Étape 1 : écrire le test qui échoue**

```typescript
it("régénère l'image annotée sans repasser par la détection", async () => {
  const m = await publierUnCatalogue(api, "etal-reannote", "22990000101")
  const avant = await urlAnnotee(api, m)

  // Aucun serveur de détection n'est ouvert : si la régénération appelait
  // /detect, ce test échouerait — c'est le point.
  const vision = await servirVisionFactice({ annotateSeulement: true })
  try {
    const r = await api.patch(
      `/merchant/catalogues/${m.catalogueId}/items`,
      { items: [{ zone_id: m.zones[0].id, price: "2500", quantity: 7 }] },
      { headers: { authorization: `Bearer ${m.jeton}` } }
    )
    expect(r.status).toBe(200)
  } finally {
    await vision.fermer()
  }

  expect(await urlAnnotee(api, m)).not.toBe(avant)
})

it("refuse en français quand l'image source n'est plus disponible", async () => {
  const m = await publierUnCatalogue(api, "etal-source-perdue", "22990000102")
  // Simule un catalogue d'avant la migration : identifiant source absent.
  const service: any = getContainer().resolve(VISUAL_CATALOG_MODULE)
  await service.updateVisualCatalogues({ id: m.catalogueId, source_image_id: null })

  const r = await api
    .patch(
      `/merchant/catalogues/${m.catalogueId}/items`,
      { items: [{ zone_id: m.zones[0].id, price: "3000", quantity: 1 }] },
      { headers: { authorization: `Bearer ${m.jeton}` } }
    )
    .catch((e: any) => e.response)

  // Le prix EST à jour ; c'est seulement l'image qui n'a pas suivi. Laisser
  // croire que rien n'a changé serait le pire comportement (risque R1).
  expect(r.status).toBe(200)
  expect(r.data.avertissement).toContain("image")
  const detail = await api.get(`/merchant/catalogues/${m.catalogueId}`, {
    headers: { authorization: `Bearer ${m.jeton}` },
  })
  expect(detail.data.catalogue.zones[0].product.variants[0].prix).toBe(3000)
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Attendu : ÉCHEC — la route `PATCH .../items` n'existe pas (404)

- [ ] **Étape 3 : ajouter la colonne et générer la migration**

```typescript
// src/modules/visual-catalog/models/visual-catalogue.ts — ajout
  // Nullable : les catalogues créés avant cette colonne (28 du corpus,
  // démonstrations) ne l'ont pas, et doivent rester lisibles. Leur seule
  // limite est qu'on ne peut pas régénérer leur image.
  source_image_id: model.text().nullable(),
```

```bash
cd marketlens-commerce && npx medusa db:generate visual_catalog && npx medusa db:migrate
```

- [ ] **Étape 4 : persister l'identifiant à la création du brouillon**

Dans `src/workflows/analyze-catalogue-photo.ts`, à côté de
`source_image_url: d.fichiers[0].url`, ajouter
`source_image_id: d.fichiers[0].id`. Ajouter le champ au type d'entrée de
`createCatalogueDraftStep` et à l'objet persisté.

- [ ] **Étape 5 : écrire le flux d'annotation réutilisable**

```typescript
// src/workflows/annoter-catalogue.ts
import {
  createStep, createWorkflow, StepResponse, WorkflowResponse, transform,
} from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { uploadFilesWorkflow } from "@medusajs/medusa/core-flows"
import { ProduitAnnote, annoterImage } from "../lib/vision-client"
import { VISUAL_CATALOG_MODULE } from "../modules/visual-catalog"

/** Seule `name` survit à la sérialisation de l'orchestrateur : `instanceof` et
 *  `type` sont inutilisables côté route. Constaté au lot 3. */
export class ErreurImageSourceIndisponible extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ErreurImageSourceIndisponible"
  }
}

const lireImageSourceStep = createStep(
  "lire-image-source",
  async (input: { source_image_id: string | null }, { container }) => {
    if (!input.source_image_id) {
      throw new ErreurImageSourceIndisponible(
        "La photo d'origine de ce catalogue n'est plus disponible."
      )
    }
    const fichiers: any = container.resolve(Modules.FILE)
    try {
      const octets = await fichiers.getAsBuffer(input.source_image_id)
      return new StepResponse(octets.toString("binary"))
    } catch {
      throw new ErreurImageSourceIndisponible(
        "La photo d'origine de ce catalogue n'est plus disponible."
      )
    }
  }
)

const annoterStep = createStep(
  "annoter",
  async (input: { contenu: string; produits: ProduitAnnote[] }) => {
    const octets = await annoterImage(
      Buffer.from(input.contenu, "binary"), "annotee.jpg", input.produits
    )
    return new StepResponse(octets.toString("binary"))
  }
)

const enregistrerUrlStep = createStep(
  "enregistrer-url-annotee",
  async (input: { catalogue_id: string; url: string }, { container }) => {
    const service: any = container.resolve(VISUAL_CATALOG_MODULE)
    const avant = await service.retrieveVisualCatalogue(input.catalogue_id)
    await service.updateVisualCatalogues({
      id: input.catalogue_id, annotated_image_url: input.url,
    })
    // La compensation reçoit l'identifiant EN PLUS de l'URL précédente : sans
    // lui, elle ne saurait pas quelle ligne remettre en état.
    return new StepResponse(
      { url: input.url },
      { catalogue_id: input.catalogue_id, url: avant.annotated_image_url }
    )
  },
  async (urlPrecedente, { container }) => {
    // `undefined` signifie que l'étape n'a jamais réussi : il n'y a rien à
    // défaire. Une valeur `null` est en revanche une vraie valeur d'avant
    // (catalogue jamais annoté) et doit être restaurée telle quelle.
    if (urlPrecedente === undefined) return
    const service: any = container.resolve(VISUAL_CATALOG_MODULE)
    const logger: any = container.resolve(ContainerRegistrationKeys.LOGGER)
    try {
      await service.updateVisualCatalogues({
        id: (urlPrecedente as any).catalogue_id,
        annotated_image_url: (urlPrecedente as any).url,
      })
    } catch (e: any) {
      // Le nettoyage ne doit jamais écraser l'erreur d'origine : elle seule
      // explique pourquoi on compense. Défaut corrigé au lot 3.
      logger.error(`Compensation de l'URL annotée impossible : ${e?.message}`)
    }
  }
)

export const annoterCatalogueWorkflow = createWorkflow(
  "annoter-catalogue",
  (input: {
    catalogue_id: string
    source_image_id: string | null
    produits: ProduitAnnote[]
  }) => {
    const contenu = lireImageSourceStep({ source_image_id: input.source_image_id })
    const octets = annoterStep({ contenu, produits: input.produits })

    const fichiers = uploadFilesWorkflow.runAsStep({
      input: {
        files: [{
          filename: "catalogue-annote.jpg",
          mimeType: "image/jpeg",
          content: octets,
          access: "public",
        }],
      },
    })

    const url = transform({ fichiers }, (d) => d.fichiers[0].url)
    enregistrerUrlStep({ catalogue_id: input.catalogue_id, url })
    return new WorkflowResponse({ annotated_image_url: url })
  }
)
```

- [ ] **Étape 6 : implémenter `PATCH /merchant/catalogues/:id/items`**

La route valide les articles (prix positif, quantité entière positive ou nulle,
`zone_id` connu et **unique** dans la requête — les mêmes règles que
`validerItemsPublicationStep`, à réutiliser), met à jour les prix des variantes et
les niveaux de stock, **puis** appelle `annoterCatalogueWorkflow`.

L'ordre compte : le prix est la vérité, l'image en est une représentation. Si
l'annotation échoue, la route rend **200 avec un `avertissement`** et journalise
l'échec — jamais un 4xx, et jamais un silence.

```typescript
  try {
    await annoterCatalogueWorkflow(req.scope).run({ input: { /* ... */ } })
  } catch (e: any) {
    if (e?.name === "ErreurImageSourceIndisponible") {
      logger.warn(`Régénération impossible pour ${req.params.id} : ${e.message}`)
      return res.json({
        ok: true,
        avertissement:
          "Les prix sont à jour, mais l'image du catalogue n'a pas pu être " +
          "regénérée : la photo d'origine n'est plus disponible.",
      })
    }
    throw e
  }
  res.json({ ok: true })
```

- [ ] **Étape 7 : faire appeler le nouveau flux par la publication**

Remplacer `annotateCatalogueStep` dans `publish-catalogue.ts` par un appel à
`annoterCatalogueWorkflow.runAsStep`. Supprimer
`src/workflows/steps/annotate-catalogue.ts` une fois qu'aucun appelant ne reste.

- [ ] **Étape 8 : lancer les deux suites**

Lancer : `cd marketlens-commerce && npm run test:integration:modules && npm run test:integration:http`
Attendu : typecheck 0, toutes vertes, **sans `--forceExit`**

- [ ] **Étape 9 : commiter**

```bash
git add marketlens-commerce/src marketlens-commerce/integration-tests
git commit -m "feat(commerce): rend l'annotation reutilisable et corrige les prix apres publication"
```

---

## Tâche 7 : Dépublier et republier

**Fichiers :**
- Créer : `marketlens-commerce/src/api/merchant/catalogues/[id]/unpublish/route.ts`
- Créer : `marketlens-commerce/src/api/merchant/catalogues/[id]/republish/route.ts`
- Modifier : `marketlens-commerce/src/api/marchand/catalogues/[id]/prix/route.ts`
- Test : `marketlens-commerce/integration-tests/http/depublication.spec.ts`

**Décision D3 à appliquer strictement.** Dépublier repasse le catalogue en
`draft` : **aucun produit n'est supprimé**, stock et historique restent intacts.
Republier régénère l'image et repasse en `published` : **aucun produit n'est créé**.

**Pourquoi c'est vital.** L'identifiant produit est
`<handle-boutique>-<libellé>-<8 derniers du zone_id>` et l'index
`IDX_product_handle_unique` est **globalement unique**. Le `zone_id` est stable.
Si dépublier supprimait les produits, republier se heurterait à l'index unique
sur les produits qu'il vient lui-même d'effacer.

- [ ] **Étape 1 : écrire le test qui échoue**

```typescript
it("dépublier retire de la vitrine sans détruire les produits, et republier ne recrée rien", async () => {
  const m = await publierUnCatalogue(api, "etal-cycle", "22990000111")
  const enTete = { authorization: `Bearer ${m.jeton}` }

  const idsAvant = (await api.get(`/merchant/catalogues/${m.catalogueId}`, { headers: enTete }))
    .data.catalogue.zones.filter((z: any) => z.product).map((z: any) => z.product.id)
  expect(idsAvant.length).toBeGreaterThan(0)

  expect((await api.get(`/c/${m.handle}`)).status).toBe(200)

  const dep = await api.post(`/merchant/catalogues/${m.catalogueId}/unpublish`, {}, { headers: enTete })
  expect(dep.status).toBe(200)

  // La vitrine cesse de servir…
  const apres = await api.get(`/c/${m.handle}`).catch((e: any) => e.response)
  expect(apres.status).toBe(404)
  // …mais les produits, eux, sont intacts.
  const idsApres = (await api.get(`/merchant/catalogues/${m.catalogueId}`, { headers: enTete }))
    .data.catalogue.zones.filter((z: any) => z.product).map((z: any) => z.product.id)
  expect(idsApres).toEqual(idsAvant)

  const vision = await servirVisionFactice({ annotateSeulement: true })
  try {
    const rep = await api.post(`/merchant/catalogues/${m.catalogueId}/republish`, {}, { headers: enTete })
    expect(rep.status).toBe(200)
  } finally {
    await vision.fermer()
  }

  expect((await api.get(`/c/${m.handle}`)).status).toBe(200)
  // Aucun produit créé : c'est ce qui aurait explosé sur l'index unique.
  const idsFinaux = (await api.get(`/merchant/catalogues/${m.catalogueId}`, { headers: enTete }))
    .data.catalogue.zones.filter((z: any) => z.product).map((z: any) => z.product.id)
  expect(idsFinaux).toEqual(idsAvant)
})

it("refuse de dépublier un brouillon, et de republier un catalogue déjà en ligne", async () => {
  const m = await publierUnCatalogue(api, "etal-cycle-2", "22990000112")
  const enTete = { authorization: `Bearer ${m.jeton}` }

  const dejaEnLigne = await api
    .post(`/merchant/catalogues/${m.catalogueId}/republish`, {}, { headers: enTete })
    .catch((e: any) => e.response)
  expect(dejaEnLigne.status).toBe(409)
  expect(dejaEnLigne.data.message).toMatch(/déjà/)
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Attendu : ÉCHEC — 404 sur `unpublish`

- [ ] **Étape 3 : implémenter les deux routes**

```typescript
// src/api/merchant/catalogues/[id]/unpublish/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  marchandActifOuRefus, catalogueDuMarchand, etiquetteJournal,
} from "../../scope"
import { VISUAL_CATALOG_MODULE } from "../../../../../modules/visual-catalog"

export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const controle = await marchandActifOuRefus(
    req.scope, req.auth_context?.actor_id,
    etiquetteJournal("POST /merchant/catalogues/:id/unpublish", req)
  )
  if (!controle.autorise) {
    return res.status(controle.statut).json({ message: controle.message })
  }

  const c = await catalogueDuMarchand(req.scope, controle.marchand.id, req.params.id)
  if (!c) return res.status(404).json({ message: "Catalogue introuvable" })
  if (c.status !== "published") {
    return res.status(409).json({ message: "Ce catalogue n'est pas en ligne" })
  }

  // AUCUN produit n'est supprimé : leur identifiant contient le zone_id, qui
  // est stable, et l'index des handles produits est globalement unique. Les
  // détruire ici ferait échouer toute republication sur les produits qu'on
  // vient soi-même d'effacer.
  const service: any = req.scope.resolve(VISUAL_CATALOG_MODULE)
  await service.updateVisualCatalogues({ id: c.id, status: "draft" })
  res.json({ ok: true })
}
```

```typescript
// src/api/merchant/catalogues/[id]/republish/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  marchandActifOuRefus, detailCatalogueDuMarchand, etiquetteJournal,
} from "../../scope"
import { annoterCatalogueWorkflow } from "../../../../../workflows/annoter-catalogue"
import { VISUAL_CATALOG_MODULE } from "../../../../../modules/visual-catalog"

export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const controle = await marchandActifOuRefus(
    req.scope, req.auth_context?.actor_id,
    etiquetteJournal("POST /merchant/catalogues/:id/republish", req)
  )
  if (!controle.autorise) {
    return res.status(controle.statut).json({ message: controle.message })
  }

  const detail = await detailCatalogueDuMarchand(
    req.scope, controle.marchand.id, req.params.id
  )
  if (!detail) return res.status(404).json({ message: "Catalogue introuvable" })
  if (detail.status === "published") {
    return res.status(409).json({ message: "Ce catalogue est déjà en ligne" })
  }

  const produits = detail.zones
    .filter((z) => z.product)
    .map((z) => ({
      label: z.product!.title,
      x: z.x, y: z.y, width: z.width, height: z.height,
      price: String(z.product!.variants[0]?.prix ?? ""),
    }))

  if (produits.length === 0) {
    // Republier un catalogue sans aucun produit servirait une vitrine vide,
    // et la publication elle-même refuse déjà ce cas.
    return res.status(409).json({
      message: "Ce catalogue n'a aucun produit à remettre en ligne",
    })
  }

  try {
    await annoterCatalogueWorkflow(req.scope).run({
      input: {
        catalogue_id: detail.id,
        source_image_id: (detail as any).source_image_id ?? null,
        produits,
      },
    })
  } catch (e: any) {
    if (e?.name === "ErreurImageSourceIndisponible") {
      // Le catalogue RESTE en brouillon : remettre en ligne sans image à jour
      // servirait une vitrine qui ment sur les prix.
      logger.warn(`Republication impossible pour ${detail.id} : ${e.message}`)
      return res.status(409).json({
        message:
          "La photo d'origine de ce catalogue n'est plus disponible : " +
          "reprenez une photo de votre étal pour le remettre en ligne.",
      })
    }
    throw e
  }

  const service: any = req.scope.resolve(VISUAL_CATALOG_MODULE)
  await service.updateVisualCatalogues({ id: detail.id, status: "published" })
  res.json({ ok: true })
}
```

`detailCatalogueDuMarchand` doit donc exposer `source_image_id` : l'ajouter au
type `DetailCatalogue` et aux `fields` de la requête en même temps que la colonne
est créée en tâche 6.

- [ ] **Étape 4 : ajouter les boutons à l'écran des prix**

Deux formulaires POST vers `/merchant/catalogues/:id/unpublish` et `/republish`.
Le bouton « Retirer de la vitrine » est en `class="sec"` : c'est une action que
la commerçante ne doit pas déclencher par inadvertance.

- [ ] **Étape 5 : lancer le test et vérifier qu'il passe**

Attendu : SUCCÈS, 2 tests

- [ ] **Étape 6 : vérifier ROUGE la garantie centrale**

Modifier temporairement `unpublish` pour qu'il supprime les produits. Le test
« republier ne recrée rien » DOIT échouer sur l'index unique. Coller la sortie
dans le rapport, puis restaurer.

- [ ] **Étape 7 : commiter**

```bash
git add marketlens-commerce/src marketlens-commerce/integration-tests
git commit -m "feat(commerce): ouvre le cycle publier / depublier / republier"
```

---

## Tâche 8 : Écran de correction des prix

**Fichiers :**
- Créer : `marketlens-commerce/src/api/marchand/catalogues/[id]/prix/route.ts`
- Test : `marketlens-commerce/integration-tests/http/back-office-prix.spec.ts`

**Interfaces :**
- Consomme : `detailCatalogueDuMarchand` (tâche 3),
  `PATCH /merchant/catalogues/:id/items` (tâche 6), les deux routes de cycle (tâche 7)

L'écran affiche l'image annotée en cours, puis un tableau des produits publiés
avec leur prix actuel et leur stock. Le prix affiché est **celui lu dans Medusa**,
jamais celui de l'image — c'est la garantie que la commerçante voit la vérité même
si une régénération a échoué.

L'avertissement rendu par `PATCH` (image non regénérée) est affiché en clair,
en `class="err"`, avec le prix confirmé à jour.

- [ ] **Étape 1 : écrire le test qui échoue**

```typescript
it("affiche les prix lus dans Medusa et les met à jour", async () => {
  const { cookie, catalogueId, jeton, zones } = await connecterEtPublier(
    api, "etal-prix", "22990000121"
  )
  const p = await api.get(`/marchand/catalogues/${catalogueId}/prix`, { headers: { cookie } })
  expect(p.status).toBe(200)
  expect(p.data).toContain("750")     // le prix posé à la publication
})

it("redirige un visiteur sans session et ne révèle rien", async () => {
  const { catalogueId, zones } = await connecterEtPublier(api, "etal-prix-2", "22990000122")
  const p = await api.get(`/marchand/catalogues/${catalogueId}/prix`, {
    maxRedirects: 0, validateStatus: () => true,
  })
  expect(p.status).toBe(302)
  expect(p.data).not.toContain(zones[0].detected_label)
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Attendu : ÉCHEC — 404

- [ ] **Étape 3 : implémenter l'écran**

```typescript
// src/api/marchand/catalogues/[id]/prix/route.ts
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { brut, html } from "../../../../../lib/html"
import { page, pageIntrouvable } from "../../../../../lib/pages/layout"
import { pageMarchandOuRedirection } from "../../../garde"
import { detailCatalogueDuMarchand } from "../../../../merchant/catalogues/scope"

const SCRIPT = `
document.getElementById("enregistrer").onclick = async () => {
  const items = []
  for (const tr of document.querySelectorAll("tr[data-zone]")) {
    items.push({
      zone_id: tr.dataset.zone,
      price: tr.querySelector("[data-prix]").value.trim(),
      quantity: Number(tr.querySelector("[data-qte]").value),
    })
  }
  const msg = document.getElementById("msg")
  msg.className = "ok"; msg.textContent = "Enregistrement…"
  const id = location.pathname.split("/")[3]
  const r = await fetch("/merchant/catalogues/" + id + "/items", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) {
    msg.className = "err"; msg.textContent = d.message || "Enregistrement impossible."
    return
  }
  if (d.avertissement) {
    // Les prix SONT à jour ; seule l'image est en retard. Le taire serait le
    // pire comportement possible.
    msg.className = "err"; msg.textContent = d.avertissement
    return
  }
  msg.className = "ok"; msg.textContent = "Prix mis à jour, image regénérée."
  setTimeout(() => location.reload(), 900)
}
`

export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const marchand = await pageMarchandOuRedirection(
    req, res, "GET /marchand/catalogues/:id/prix"
  )
  if (!marchand) return

  const detail = await detailCatalogueDuMarchand(req.scope, marchand.id, req.params.id)
  if (!detail) {
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    return res.status(404).send(pageIntrouvable())
  }

  const vendus = detail.zones.filter((z) => z.product)

  const lignes = vendus.map(
    (z) => html`
      <tr data-zone="${z.id}">
        <td>${z.product!.title}</td>
        <td><input data-prix value="${z.product!.variants[0]?.prix ?? ""}"
                   inputmode="numeric"></td>
        <td><input data-qte value="0" inputmode="numeric"></td>
      </tr>`
  )

  const corps = html`
    <h1>${detail.title}</h1>
    <p class="sous">
      ${detail.status === "published"
        ? html`En ligne · <a class="lien" href="/c/${detail.handle}">voir la vitrine</a>`
        : "Retiré de la vitrine"}
    </p>
    ${detail.annotated_image_url
      ? html`<img src="${detail.annotated_image_url}" alt="">`
      : null}
    <div class="carte">
      <table>
        <thead><tr>
          <th>Produit</th><th style="width:120px">Prix (FCFA)</th>
          <th style="width:130px">Quantité par déclinaison</th>
        </tr></thead>
        <tbody>${lignes}</tbody>
      </table>
      <button id="enregistrer">Enregistrer</button>
      <div id="msg" style="margin-top:14px"></div>
    </div>
    <div class="carte">
      ${detail.status === "published"
        ? html`<form method="post" action="/merchant/catalogues/${detail.id}/unpublish">
            <button class="sec" type="submit">Retirer de la vitrine</button>
          </form>`
        : html`<form method="post" action="/merchant/catalogues/${detail.id}/republish">
            <button type="submit">Remettre en ligne</button>
          </form>`}
    </div>
    <script>${brut(SCRIPT)}</script>`

  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.send(page({ titre: detail.title, marchand: marchand.name, corps }))
}
```

Le prix affiché vient de `variants[0].prix`, **lu dans Medusa** — jamais de
l'image. C'est ce qui garantit que la commerçante voit la vérité même après une
régénération ratée.

- [ ] **Étape 4 : lancer le test et vérifier qu'il passe**

Attendu : SUCCÈS, 2 tests

- [ ] **Étape 5 : commiter**

```bash
git add marketlens-commerce/src/api/marchand marketlens-commerce/integration-tests/http/back-office-prix.spec.ts
git commit -m "feat(commerce): ecran de correction des prix et des stocks"
```

---

## Tâche 9 : La vitrine affiche les prix lus dans Medusa

**Fichiers :**
- Modifier : `marketlens-commerce/src/api/c/[handle]/route.ts`
- Modifier : `marketlens-commerce/src/api/store/catalogues/[handle]/route.ts`
- Test : `marketlens-commerce/integration-tests/http/merchant-isolation.spec.ts` (étendre)

**Décision D2, second volet.** L'image annotée garde ses prix — elle est
partagée sur WhatsApp. Mais la vitrine web les affiche **en texte, lus dans
Medusa**. Si une régénération d'image a échoué, le web reste juste.

`prixXof` de la tâche 3 est réutilisée : lecture directe de
`variants.prices.amount` filtré sur `xof`. Limite assumée notée R2 dans la spec.

- [ ] **Étape 1 : écrire le test qui échoue**

```typescript
it("la vitrine affiche le prix lu dans Medusa, même si l'image est en retard", async () => {
  const m = await publierUnCatalogue(api, "etal-prix-vitrine", "22990000131", "750")

  const vision = await servirVisionFactice({ annotateSeulement: true })
  try {
    await api.patch(
      `/merchant/catalogues/${m.catalogueId}/items`,
      { items: [{ zone_id: m.zones[0].id, price: "1900", quantity: 3 }] },
      { headers: { authorization: `Bearer ${m.jeton}` } }
    )
  } finally {
    await vision.fermer()
  }

  const page = await api.get(`/c/${m.handle}`)
  expect(page.status).toBe(200)
  expect(page.data).toContain("1900")
  expect(page.data).not.toContain("750")
})
```

- [ ] **Étape 2 : lancer le test et vérifier qu'il échoue**

Attendu : ÉCHEC — la page ne contient aucun prix, seule l'image en porte

- [ ] **Étape 3 : implémenter**

Ajouter les champs de prix à la requête `query.graph` des deux routes, et afficher
le prix formaté en FCFA sur chaque carte produit de `/c/<handle>`. La route JSON
`/store/catalogues/:handle` expose le prix par variante.

**Réécrire la page `/c/<handle>` avec `html` de la tâche 1** et retirer la
fonction `echapper()` locale : c'est exactement le motif d'échappement manuel que
la tâche 1 supprime, et le laisser en place serait garder la faille qu'on a
outillée contre.

- [ ] **Étape 4 : lancer les deux suites complètes**

Lancer : `cd marketlens-commerce && npm run test:integration:modules && npm run test:integration:http`
Attendu : typecheck 0, toutes vertes, sans `--forceExit`

- [ ] **Étape 5 : mettre le README à jour**

Ajouter `/marchand` au tableau des adresses consultables et retirer la mention
« l'interface marchande reste à construire ».

- [ ] **Étape 6 : commiter**

```bash
git add marketlens-commerce docs README.md
git commit -m "feat(commerce): la vitrine affiche les prix lus dans Medusa"
```

---

## Vérification finale de tout le lot

- [ ] `npm run typecheck` sort 0
- [ ] `npm run test:integration:modules` et `npm run test:integration:http` sortent 0
      **sans `--forceExit`**
- [ ] `cd services/vision && .venv/Scripts/python -m pytest tests/ -q` sort 0
- [ ] Les douze contraintes globales sont vérifiées une à une, contre la spec et
      non contre ce plan
- [ ] Chaque garde de sécurité a été vue **rouge** avant d'être déclarée couverte
- [ ] Le parcours complet a été fait à la main dans un navigateur, contre une
      analyse fraîche du service de vision — la base de développement ne contient
      que des images factices de 6 octets (contrainte 11)
