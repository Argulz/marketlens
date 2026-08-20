# Module `visual-catalog` et workflows photo → produits — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qu'une photo d'étal envoyée par un marchand devienne de vrais produits Medusa — avec variantes, prix en XOF et stock — et un catalogue partageable.

**Architecture:** Un module `visual-catalog` porte la photo et la géométrie des zones ; les produits, prix et stock vivent dans Medusa. **Deux workflows distincts** : l'analyse ne crée aucune donnée commerciale et produit un brouillon corrigeable ; la publication est la transaction qui crée de la valeur, avec compensation sur chaque étape. Le service de vision est appelé en HTTP derrière un secret partagé.

**Tech Stack:** Medusa 2.18.0, Node 20+, PostgreSQL 16, TypeScript, Jest via `@medusajs/test-utils`, service de vision FastAPI.

**Spec:** `docs/superpowers/specs/2026-08-16-marketlens-medusa-socle-design.md`
**Contraintes héritées :** `docs/superpowers/specs/notes-plan-3.md`

## Vérité terrain établie avant ce plan

Vérifiée contre le Medusa réellement installé et la base réellement en cours, **pas supposée** :

| Fait | État |
|---|---|
| `uploadFilesWorkflow`, `deleteFilesWorkflow` | présents. Entrée : `{ files: [{ filename, mimeType, content }] }`, `content` est une **chaîne** |
| `createProductsWorkflow`, `createInventoryLevelsWorkflow`, `updateProductsWorkflow` | présents |
| `createInventoryLevelsWorkflow` | entrée `{ inventory_levels: [...] }` |
| `createRegionsWorkflow` | présent |
| Paquets `@medusajs/medusa/file`, `file-local`, `file-s3` | installés ; `file-local` résolvable |
| **Module *File* dans `medusa-config.ts`** | **ABSENT — aucun provider configuré** |
| **Régions en base** | **AUCUNE** — or les prix Medusa vivent dans une devise portée par une région |
| Marchands en base | 2 (créés en démonstration) |
| Champs de lien | `sales_channel`, `stock_location`, `api_key` — **au singulier** |

Les deux lignes en gras sont des lacunes que ni la spec ni les plans précédents n'avaient anticipées. Elles sont traitées en Task 2, avant toute construction.

## Global Constraints

- **Jamais de clé étrangère entre modules** — les rattachements passent par `defineLink` dans `src/links/`.
- **Le prix, les variantes et le stock n'appartiennent pas au catalogue visuel.** La zone ne porte que sa géométrie, son label détecté et son lien vers le produit.
- Coordonnées **normalisées 0–1000** ; devise **`xof` en minuscules**.
- **Le regroupement par marchand ne doit jamais reposer sur les collections ni les catégories Medusa** — elles sont globales à l'instance et traversent la clé publiable. Voir `notes-plan-3.md`.
- **Un catalogue à moitié publié est un état interdit** : chaque étape qui crée porte sa compensation.
- L'identifiant du marchand vient **toujours** du jeton, jamais du corps ni de l'URL.
- Aucun test ne dépend de l'ordre d'exécution. Identifiants déjà pris : `collision`, `echec-aval`, `etal-de-fatou`, `doublon`, `etal-de-kofi`, `boutique-akosua`, `sans-jeton`, `etal-fatou`, `doudou`, `etal-yaa`, `etal-kwame`, `etal-nafi`, `etal-de-demo`, `etal-de-demo-2`.
- **Aucun test de la suite par défaut n'appelle Gemini.** Le service de vision est doublé par un stub HTTP.
- **Indexer par chemins explicites, jamais `git add -A`** : `hackathon_scenai_vision.md` traîne non suivi et appartient à un autre projet.
- Messages d'erreur destinés à l'utilisateur **en français**.
- `npx tsc --noEmit -p tsconfig.json` doit sortir à zéro avant chaque commit — `@swc/jest` transpile sans vérifier les types.

## Pièges déjà payés sur ce chantier

Ne les redécouvrez pas :

1. **Interpoler une entrée de workflow dans un gabarit de chaîne lève une `TypeError`** — les entrées sont des proxies. Tout passe par `transform()`.
2. **Les rejets de `.run()` d'un workflow ne sont pas des `Error`** — l'orchestrateur rejette avec un objet simple ; `rejects.toThrow()` ne les reconnaît jamais. Utilisez un `try/catch`. Les appels **directs** de service rejettent de vraies `Error`.
3. **L'orchestrateur est strictement séquentiel** : une étape qui échoue empêche toutes les suivantes. Pour tester une compensation, il faut forcer l'échec **en aval**.
4. `@medusajs/test-utils` ignore `DATABASE_URL` et lit `DB_HOST`/`DB_PORT`/`DB_USERNAME`/`DB_PASSWORD`. Déjà réglé.
5. **Changer `services/vision/.env` exige un redémarrage** du service — `uvicorn --reload` ne surveille que les `.py`.

## Structure de fichiers

```
marketlens-commerce/
├── medusa-config.ts                          # + module File (provider local)
├── src/
│   ├── modules/visual-catalog/
│   │   ├── models/{visual-catalogue,catalogue-zone}.ts
│   │   ├── service.ts
│   │   └── index.ts
│   ├── links/{merchant-visual-catalogue,catalogue-zone-product}.ts
│   ├── lib/vision-client.ts                  # client HTTP du service de vision
│   ├── workflows/
│   │   ├── analyze-catalogue-photo.ts
│   │   ├── publish-catalogue.ts
│   │   └── steps/{detect-products,annotate-catalogue,create-catalogue-draft}.ts
│   ├── api/merchant/catalogues/
│   │   ├── route.ts                          # POST analyse, GET liste
│   │   └── [id]/publish/route.ts             # POST publication
│   ├── api/store/catalogues/[handle]/route.ts
│   └── scripts/seed-legacy.ts
└── integration-tests/
    ├── modules/visual-catalog.spec.ts
    └── http/{catalogue-analyze,catalogue-publish,catalogue-store,catalogue-isolation}.spec.ts
```

`lib/vision-client.ts` ne connaît ni workflow ni HTTP entrant : il parle au service de vision, rien d'autre. Les modèles ne connaissent que la forme des données. Les routes délèguent aux workflows.

---

### Task 1 : Fermer les dettes du plan 2

Ce plan bâtit sur `/merchant/*` et sur le `handle`. Les deux dettes parquées mordent ici avant toute autre chose.

**Files:**
- Modify: `marketlens-commerce/src/api/middlewares.ts`
- Modify: `marketlens-commerce/src/workflows/steps/create-merchant-record.ts`
- Test: `marketlens-commerce/integration-tests/http/merchant-auth.spec.ts`, `marketlens-commerce/integration-tests/http/merchant-provisioning.spec.ts`

**Interfaces:**
- Consumes: `createMerchantRecordStep`, `defineMiddlewares`, `authenticate`
- Produces: aucune nouvelle interface — durcissement de l'existant

- [ ] **Step 1 : Écrire les deux tests qui échouent**

Dans `integration-tests/http/merchant-auth.spec.ts` :

```ts
it("refuse un GET sur /merchant/register", async () => {
  // La règle d'inscription est restreinte à POST, et le matcher général
  // exclut ce chemin pour tous les verbes : sans seconde règle, un GET
  // n'est protégé par rien. Un 404 signalerait que le middleware n'est
  // jamais atteint — donc qu'une future route y serait ouverte.
  const reponse = await api.get("/merchant/register").catch((e) => e.response)
  expect(reponse.status).toBe(401)
})
```

Dans `integration-tests/http/merchant-provisioning.spec.ts` :

```ts
it("normalise le handle même appelé directement par le workflow", async () => {
  // La normalisation vivait dans la route d'inscription. Tout appel direct
  // — script d'opérateur, autre workflow — persistait un handle brut, et
  // deux casses différentes se disputeraient la même URL publique /c/<handle>.
  const { result } = await createMerchantWorkflow(getContainer()).run({
    input: { name: "Étal Direct", handle: "  ETAL-Direct  ", phone: "22990007001" },
  })

  const service = getContainer().resolve(MERCHANT_MODULE)
  const marchand = await service.retrieveMerchant(result.merchant_id)
  expect(marchand.handle).toBe("etal-direct")
})
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```bash
cd marketlens-commerce && npm run test:integration:http
```

Attendu : `refuse un GET sur /merchant/register` reçoit **404** au lieu de 401 ; `normalise le handle` reçoit `"  ETAL-Direct  "` au lieu de `"etal-direct"`.

- [ ] **Step 3 : Ajouter la règle de middleware manquante**

Dans `src/api/middlewares.ts`, **avant** la règle générale, ajouter :

```ts
    {
      // La règle d'inscription ci-dessus ne couvre que POST, et le matcher
      // général exclut /merchant/register pour tous les verbes. Sans cette
      // règle, tout autre verbe sur ce chemin serait non authentifié.
      matcher: "/merchant/register",
      methods: ["GET", "PUT", "PATCH", "DELETE"],
      middlewares: [authenticate("merchant", ["session", "bearer"])],
    },
```

- [ ] **Step 4 : Rendre la normalisation structurelle**

Dans `src/workflows/steps/create-merchant-record.ts`, normaliser dans l'étape elle-même, avant persistance :

```ts
const MOTIF_HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function normaliserHandle(brut: string): string {
  const handle = brut.trim().toLowerCase()
  if (!MOTIF_HANDLE.test(handle)) {
    throw new Error(
      `Le handle « ${brut} » doit être composé de lettres minuscules, de ` +
      `chiffres et de tirets simples`
    )
  }
  return handle
}
```

et l'appliquer à `input.handle` dans le corps de l'étape. La validation de la route reste en place : elle rend un 400 propre avant d'atteindre le workflow ; celle-ci est le filet pour tout appel direct.

- [ ] **Step 5 : Lancer les tests pour vérifier qu'ils passent**

```bash
cd marketlens-commerce && npm run test:integration:http && npm run test:integration:modules
```

Attendu : toute la suite verte, avec deux tests de plus qu'avant.

- [ ] **Step 6 : Commit**

```bash
git add marketlens-commerce/src marketlens-commerce/integration-tests
git commit -m "fix(commerce): ferme les deux dettes du socle avant le catalogue visuel"
```

---

### Task 2 : Prérequis d'infrastructure — module File et région XOF

Deux lacunes découvertes en établissant la vérité terrain. Sans elles, aucune photo ne peut être stockée et aucun prix affiché.

**Files:**
- Modify: `marketlens-commerce/medusa-config.ts`
- Create: `marketlens-commerce/src/workflows/ensure-region.ts`
- Test: `marketlens-commerce/integration-tests/http/infrastructure.spec.ts`

**Interfaces:**
- Consumes: `uploadFilesWorkflow`, `createRegionsWorkflow`
- Produces: `assurerRegionXof(container) => Promise<string>` (export de `src/workflows/ensure-region.ts`), renvoyant l'`id` de la région XOF, créée si absente. Le module *File* devient utilisable avec le provider local, les fichiers atterrissant dans `static/`.

- [ ] **Step 1 : Écrire les tests qui échouent**

`integration-tests/http/infrastructure.spec.ts` :

```ts
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { uploadFilesWorkflow } from "@medusajs/medusa/core-flows"
import { assurerRegionXof } from "../../src/workflows/ensure-region"

jest.setTimeout(60 * 1000)

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    describe("Prérequis d'infrastructure", () => {
      it("stocke un fichier via le module File", async () => {
        const { result } = await uploadFilesWorkflow(getContainer()).run({
          input: {
            files: [{
              filename: "etal.jpg",
              mimeType: "image/jpeg",
              content: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("binary"),
            }],
          },
        })
        expect(result[0].url).toBeTruthy()
      })

      it("crée la région XOF si elle est absente, et la réutilise sinon", async () => {
        const premier = await assurerRegionXof(getContainer())
        const second = await assurerRegionXof(getContainer())
        expect(premier).toBeTruthy()
        expect(second).toBe(premier)
      })
    })
  },
})
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```bash
cd marketlens-commerce && npm run test:integration:http -- infrastructure
```

Attendu : ÉCHEC à la collecte (`Cannot find module '../../src/workflows/ensure-region'`).

- [ ] **Step 3 : Configurer le module File**

Dans `medusa-config.ts`, ajouter au tableau `modules`, après le module `merchant` :

```ts
    {
      resolve: "@medusajs/medusa/file",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/file-local",
            id: "local",
            options: { upload_dir: "static", backend_url: "http://localhost:9000/static" },
          },
        ],
      },
    },
```

**Vérifiez que le test d'upload passe avec cette configuration seule.** Si le module *File* était déjà utilisable sans elle, dites-le dans votre rapport plutôt que d'ajouter une configuration inutile.

Ajouter `static/` au `.gitignore` de `marketlens-commerce` : les photos d'étal ne se versionnent pas.

- [ ] **Step 4 : Écrire l'assurance de région**

`src/workflows/ensure-region.ts` :

```ts
import { createRegionsWorkflow } from "@medusajs/medusa/core-flows"
import { MedusaContainer } from "@medusajs/framework/types"

export const NOM_REGION_XOF = "Afrique de l'Ouest (XOF)"

/**
 * Les prix Medusa vivent dans une devise portée par une région ; sans région
 * XOF, la vitrine ne peut afficher aucun prix. Idempotent : appelable à
 * chaque publication sans créer de doublon.
 */
export async function assurerRegionXof(container: MedusaContainer): Promise<string> {
  const query = container.resolve("query")
  const { data } = await query.graph({
    entity: "region",
    fields: ["id", "currency_code"],
    filters: { currency_code: "xof" },
  })

  if (data.length > 0) {
    return data[0].id
  }

  const { result } = await createRegionsWorkflow(container).run({
    input: { regions: [{ name: NOM_REGION_XOF, currency_code: "xof", countries: ["bj"] }] },
  })
  return result[0].id
}
```

- [ ] **Step 5 : Lancer les tests pour vérifier qu'ils passent**

```bash
cd marketlens-commerce && npm run test:integration:http -- infrastructure
```

Attendu : 2 tests PASSÉS.

- [ ] **Step 6 : Commit**

```bash
git add marketlens-commerce/medusa-config.ts marketlens-commerce/src marketlens-commerce/integration-tests marketlens-commerce/.gitignore
git commit -m "feat(commerce): module File local et région XOF, prérequis du catalogue"
```

---

### Task 3 : Module `visual-catalog`

**Files:**
- Create: `marketlens-commerce/src/modules/visual-catalog/models/visual-catalogue.ts`
- Create: `marketlens-commerce/src/modules/visual-catalog/models/catalogue-zone.ts`
- Create: `marketlens-commerce/src/modules/visual-catalog/service.ts`
- Create: `marketlens-commerce/src/modules/visual-catalog/index.ts`
- Create: `marketlens-commerce/src/links/merchant-visual-catalogue.ts`
- Create: `marketlens-commerce/src/links/catalogue-zone-product.ts`
- Modify: `marketlens-commerce/medusa-config.ts`
- Test: `marketlens-commerce/integration-tests/modules/visual-catalog.spec.ts`

**Interfaces:**
- Consumes: `MERCHANT_MODULE` (module `merchant`)
- Produces: `VISUAL_CATALOG_MODULE = "visual_catalog"` (export nommé de `src/modules/visual-catalog/index.ts`) ; `VisualCatalogModuleService` avec les méthodes générées par `MedusaService` : `createVisualCatalogues`, `listVisualCatalogues`, `retrieveVisualCatalogue`, `updateVisualCatalogues`, `deleteVisualCatalogues`, et les équivalents `...CatalogueZones`. Entité `VisualCatalogue` : `id`, `handle`, `title`, `source_image_url`, `annotated_image_url`, `status`. Entité `CatalogueZone` : `id`, `x`, `y`, `width`, `height`, `detected_label`, `detected_category`, plus la relation vers son catalogue.

- [ ] **Step 1 : Écrire le test de module qui échoue**

`integration-tests/modules/visual-catalog.spec.ts` :

```ts
import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { VISUAL_CATALOG_MODULE } from "../../src/modules/visual-catalog"
import VisualCatalogModuleService from "../../src/modules/visual-catalog/service"
import { VisualCatalogue } from "../../src/modules/visual-catalog/models/visual-catalogue"
import { CatalogueZone } from "../../src/modules/visual-catalog/models/catalogue-zone"

moduleIntegrationTestRunner<VisualCatalogModuleService>({
  moduleName: VISUAL_CATALOG_MODULE,
  resolve: "./src/modules/visual-catalog",
  moduleModels: [VisualCatalogue, CatalogueZone],
  testSuite: ({ service }) => {
    describe("VisualCatalogModuleService", () => {
      it("crée un catalogue en brouillon par défaut", async () => {
        const cat = await service.createVisualCatalogues({
          handle: "etal-du-matin",
          title: "Étal du matin",
          source_image_url: "http://localhost:9000/static/etal.jpg",
        })
        expect(cat.status).toBe("draft")
        expect(cat.annotated_image_url).toBeNull()
      })

      it("refuse deux catalogues portant le même handle", async () => {
        await service.createVisualCatalogues({
          handle: "doublon-cat", title: "A",
          source_image_url: "http://x/a.jpg",
        })
        await expect(
          service.createVisualCatalogues({
            handle: "doublon-cat", title: "B",
            source_image_url: "http://x/b.jpg",
          })
        ).rejects.toThrow()
      })

      it("porte des zones dont la géométrie survit au stockage", async () => {
        const cat = await service.createVisualCatalogues({
          handle: "etal-zones", title: "Zones",
          source_image_url: "http://x/z.jpg",
        })
        const zone = await service.createCatalogueZones({
          catalogue_id: cat.id,
          x: 250, y: 400, width: 200, height: 150,
          detected_label: "Tomates",
          detected_category: "fruits_legumes",
        })
        const relue = await service.retrieveCatalogueZone(zone.id)
        expect([relue.x, relue.y, relue.width, relue.height]).toEqual([250, 400, 200, 150])
      })
    })
  },
})
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

```bash
cd marketlens-commerce && npm run test:integration:modules
```

Attendu : ÉCHEC à la collecte, `Cannot find module '../../src/modules/visual-catalog'`.

- [ ] **Step 3 : Écrire les modèles**

`src/modules/visual-catalog/models/visual-catalogue.ts` :

```ts
import { model } from "@medusajs/framework/utils"
import { CatalogueZone } from "./catalogue-zone"

export const VisualCatalogue = model.define("visual_catalogue", {
  id: model.id().primaryKey(),
  handle: model.text().unique(),
  title: model.text(),
  source_image_url: model.text(),
  annotated_image_url: model.text().nullable(),
  status: model.enum(["draft", "published"]).default("draft"),
  zones: model.hasMany(() => CatalogueZone, { mappedBy: "catalogue" }),
})
```

`src/modules/visual-catalog/models/catalogue-zone.ts` :

```ts
import { model } from "@medusajs/framework/utils"
import { VisualCatalogue } from "./visual-catalogue"

export const CatalogueZone = model.define("catalogue_zone", {
  id: model.id().primaryKey(),
  // Coordonnées normalisées 0–1000 : x et y sont le centre de la zone.
  // Indépendantes de la résolution, donc valides sur l'image annotée
  // comme sur l'originale.
  x: model.number(),
  y: model.number(),
  width: model.number(),
  height: model.number(),
  detected_label: model.text(),
  detected_category: model.text(),
  catalogue: model.belongsTo(() => VisualCatalogue, { mappedBy: "zones" }),
})
```

Aucune colonne `product_id` : le rattachement est un *module link*, créé à l'étape suivante.

- [ ] **Step 4 : Écrire le service et l'enregistrement**

`src/modules/visual-catalog/service.ts` :

```ts
import { MedusaService } from "@medusajs/framework/utils"
import { CatalogueZone } from "./models/catalogue-zone"
import { VisualCatalogue } from "./models/visual-catalogue"

class VisualCatalogModuleService extends MedusaService({
  VisualCatalogue,
  CatalogueZone,
}) {}

export default VisualCatalogModuleService
```

`src/modules/visual-catalog/index.ts` :

```ts
import { Module } from "@medusajs/framework/utils"
import VisualCatalogModuleService from "./service"

export const VISUAL_CATALOG_MODULE = "visual_catalog"

export default Module(VISUAL_CATALOG_MODULE, {
  service: VisualCatalogModuleService,
})
```

Dans `medusa-config.ts`, ajouter `{ resolve: "./src/modules/visual-catalog" }` au tableau `modules`.

- [ ] **Step 5 : Déclarer les liens de modules**

`src/links/merchant-visual-catalogue.ts` :

```ts
import { defineLink } from "@medusajs/framework/utils"
import MerchantModule from "../modules/merchant"
import VisualCatalogModule from "../modules/visual-catalog"

export default defineLink(
  MerchantModule.linkable.merchant,
  { linkable: VisualCatalogModule.linkable.visualCatalogue, isList: true }
)
```

Un marchand porte **plusieurs** catalogues — d'où `isList: true`, contrairement aux liens un-à-un du plan 2.

`src/links/catalogue-zone-product.ts` :

```ts
import { defineLink } from "@medusajs/framework/utils"
import ProductModule from "@medusajs/medusa/product"
import VisualCatalogModule from "../modules/visual-catalog"

export default defineLink(
  VisualCatalogModule.linkable.catalogueZone,
  ProductModule.linkable.product
)
```

Une zone pointe vers un **produit**, pas vers une variante : la zone représente « ce tas de tomates », les variantes sont les choix à l'intérieur.

- [ ] **Step 6 : Générer et appliquer les migrations**

```bash
cd marketlens-commerce && npx medusa db:generate visual_catalog && npx medusa db:migrate
```

Attendu : une migration apparaît sous `src/modules/visual-catalog/migrations/`, puis `Migrations completed`.

- [ ] **Step 7 : Lancer les tests et la vérification de types**

```bash
cd marketlens-commerce && npm run test:integration:modules && npx tsc --noEmit -p tsconfig.json
```

Attendu : 3 tests de module de plus, `tsc` à zéro erreur.

**Notez dans votre rapport le nom réel des champs de lien** tels que `query.graph` les expose — `visual_catalogues` au pluriel côté marchand, `product` au singulier côté zone. Les tâches 6 et 7 en dépendent.

- [ ] **Step 8 : Commit**

```bash
git add marketlens-commerce/src marketlens-commerce/medusa-config.ts marketlens-commerce/integration-tests
git commit -m "feat(commerce): module visual-catalog et ses liens"
```

---

### Task 4 : Client du service de vision

**Files:**
- Create: `marketlens-commerce/src/lib/vision-client.ts`
- Test: `marketlens-commerce/integration-tests/modules/vision-client.spec.ts`

**Interfaces:**
- Consumes: rien
- Produces: `detecterProduits(octets: Buffer, nomFichier: string): Promise<ZoneDetectee[]>` et `annoterImage(octets: Buffer, nomFichier: string, produits: ProduitAnnote[]): Promise<Buffer>`, exports de `src/lib/vision-client.ts`. `ZoneDetectee = { label: string; x: number; y: number; width: number; height: number; category: string }`. `ProduitAnnote = ZoneDetectee & { price: string }`. Erreurs : `VisionIndisponible` (transport ou 5xx amont), `VisionRefuse` (4xx — notre requête est fautive).

- [ ] **Step 1 : Écrire les tests qui échouent**

`integration-tests/modules/vision-client.spec.ts` — un serveur HTTP local tient lieu de service de vision, aucun réseau externe :

```ts
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
  it("transmet le secret partagé et rend les zones détectées", async () => {
    const s = await servir((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        products: [{ label: "Tomates", x: 250, y: 400, width: 200, height: 150, category: "fruits_legumes" }],
        count: 1,
      }))
    })
    process.env.VISION_SERVICE_URL = s.url
    process.env.VISION_SERVICE_SECRET = "secret-de-test"

    const zones = await detecterProduits(JPEG, "etal.jpg")
    expect(zones).toHaveLength(1)
    expect(zones[0].label).toBe("Tomates")
    expect(s.recus[0].secret).toBe("secret-de-test")
    await s.fermer()
  })

  it("distingue un refus amont d'une indisponibilité", async () => {
    const refus = await servir((_req, res) => { res.writeHead(400); res.end("{}") })
    process.env.VISION_SERVICE_URL = refus.url
    await expect(detecterProduits(JPEG, "etal.jpg")).rejects.toBeInstanceOf(VisionRefuse)
    await refus.fermer()

    const panne = await servir((_req, res) => { res.writeHead(502); res.end("{}") })
    process.env.VISION_SERVICE_URL = panne.url
    await expect(detecterProduits(JPEG, "etal.jpg")).rejects.toBeInstanceOf(VisionIndisponible)
    await panne.fermer()
  })

  it("rend les octets JPEG annotés", async () => {
    const s = await servir((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" })
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))
    })
    process.env.VISION_SERVICE_URL = s.url

    const octets = await annoterImage(JPEG, "etal.jpg", [
      { label: "Tomates", x: 250, y: 400, width: 200, height: 150, category: "fruits_legumes", price: "500" },
    ])
    expect(octets.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    await s.fermer()
  })
})
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```bash
cd marketlens-commerce && npm run test:integration:modules -- vision-client
```

Attendu : ÉCHEC à la collecte, `Cannot find module '../../src/lib/vision-client'`.

- [ ] **Step 3 : Écrire le client**

`src/lib/vision-client.ts` :

```ts
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
  corps.append("image", new Blob([octets]), nomFichier)
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
  corps.append("image", new Blob([octets]), nomFichier)
  corps.append("products", JSON.stringify(produits))
  const reponse = await appeler("/annotate", corps)
  return Buffer.from(await reponse.arrayBuffer())
}
```

- [ ] **Step 4 : Lancer les tests et la vérification de types**

```bash
cd marketlens-commerce && npm run test:integration:modules -- vision-client && npx tsc --noEmit -p tsconfig.json
```

Attendu : 3 tests PASSÉS, `tsc` à zéro erreur.

- [ ] **Step 5 : Commit**

```bash
git add marketlens-commerce/src/lib marketlens-commerce/integration-tests
git commit -m "feat(commerce): client HTTP du service de vision"
```

---

### Task 5 : Workflow `analyzeCataloguePhoto`

**La détection ne crée aucune donnée commerciale.** Une analyse ratée ne coûte rien et s'annule sans trace.

**Files:**
- Create: `marketlens-commerce/src/workflows/steps/detect-products.ts`
- Create: `marketlens-commerce/src/workflows/steps/create-catalogue-draft.ts`
- Create: `marketlens-commerce/src/workflows/analyze-catalogue-photo.ts`
- Test: `marketlens-commerce/integration-tests/http/catalogue-analyze.spec.ts`

**Interfaces:**
- Consumes: `VISUAL_CATALOG_MODULE`, `detecterProduits`, `uploadFilesWorkflow`
- Produces: `analyzeCataloguePhotoWorkflow` (export par défaut), entrée `{ merchant_id: string; filename: string; content: string; title: string }` où `content` est le contenu du fichier en chaîne, sortie `{ catalogue_id: string; handle: string; zones: ZoneDetectee[] }`.

- [ ] **Step 1 : Écrire le test qui échoue**

`integration-tests/http/catalogue-analyze.spec.ts` :

```ts
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import analyzeCataloguePhotoWorkflow from "../../src/workflows/analyze-catalogue-photo"
import { VISUAL_CATALOG_MODULE } from "../../src/modules/visual-catalog"
import createMerchantWorkflow from "../../src/workflows/create-merchant"
import { servirVisionFactice } from "./helpers/vision-stub"

jest.setTimeout(90 * 1000)

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    describe("analyzeCataloguePhoto", () => {
      it("crée un brouillon avec ses zones, sans créer aucun produit", async () => {
        const vision = await servirVisionFactice({
          detect: {
            products: [
              { label: "Tomates", x: 250, y: 400, width: 200, height: 150, category: "fruits_legumes" },
              { label: "Ignames", x: 700, y: 500, width: 250, height: 300, category: "cereales" },
            ],
            count: 2,
          },
        })

        const { result: m } = await createMerchantWorkflow(getContainer()).run({
          input: { name: "Étal Analyse", handle: "etal-analyse", phone: "22990008001" },
        })

        const { result } = await analyzeCataloguePhotoWorkflow(getContainer()).run({
          input: {
            merchant_id: m.merchant_id,
            filename: "etal.jpg",
            content: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("binary"),
            title: "Étal du matin",
          },
        })

        const service = getContainer().resolve(VISUAL_CATALOG_MODULE)
        const cat = await service.retrieveVisualCatalogue(result.catalogue_id)
        expect(cat.status).toBe("draft")
        expect(cat.source_image_url).toBeTruthy()
        expect(cat.annotated_image_url).toBeNull()

        const zones = await service.listCatalogueZones({ catalogue_id: result.catalogue_id })
        expect(zones).toHaveLength(2)

        // Le cœur du test : aucun produit n'existe encore.
        const query = getContainer().resolve("query")
        const { data: produits } = await query.graph({ entity: "product", fields: ["id"] })
        expect(produits).toHaveLength(0)

        await vision.fermer()
      })
    })
  },
})
```

Créer `integration-tests/http/helpers/vision-stub.ts` :

```ts
import http from "http"

/** Sert des réponses figées à la place du service de vision. Aucun appel
 *  Gemini n'a lieu : ni la suite par défaut, ni ce fichier ne sortent du
 *  processus. */
export async function servirVisionFactice(reponses: {
  detect?: unknown
  annotate?: Buffer
  statutDetect?: number
}) {
  const serveur = http.createServer((req, res) => {
    if (req.url?.startsWith("/detect")) {
      if (reponses.statutDetect && reponses.statutDetect >= 400) {
        res.writeHead(reponses.statutDetect)
        return res.end("{}")
      }
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify(reponses.detect ?? { products: [], count: 0 }))
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
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

```bash
cd marketlens-commerce && npm run test:integration:http -- catalogue-analyze
```

Attendu : ÉCHEC à la collecte, `Cannot find module '../../src/workflows/analyze-catalogue-photo'`.

- [ ] **Step 3 : Écrire l'étape de détection**

`src/workflows/steps/detect-products.ts` :

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ZoneDetectee, detecterProduits } from "../../lib/vision-client"

export type DetectProductsInput = { content: string; filename: string }

/** Lecture pure : aucune compensation. Un échec ici n'a rien créé. */
export const detectProductsStep = createStep(
  "detect-products",
  async (input: DetectProductsInput): Promise<StepResponse<ZoneDetectee[]>> => {
    const octets = Buffer.from(input.content, "binary")
    const zones = await detecterProduits(octets, input.filename)
    return new StepResponse(zones)
  }
)
```

- [ ] **Step 4 : Écrire l'étape de création du brouillon, avec sa compensation**

`src/workflows/steps/create-catalogue-draft.ts` :

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { VISUAL_CATALOG_MODULE } from "../../modules/visual-catalog"
import VisualCatalogModuleService from "../../modules/visual-catalog/service"
import { ZoneDetectee } from "../../lib/vision-client"

export type CreateCatalogueDraftInput = {
  title: string
  source_image_url: string
  zones: ZoneDetectee[]
}

export const createCatalogueDraftStep = createStep(
  "create-catalogue-draft",
  async (input: CreateCatalogueDraftInput, { container }) => {
    const service = container.resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)

    // Le handle est engendré ICI et non dans un `transform` : un transform
    // peut être rejoué et produirait alors un handle différent du premier.
    // Le handle du catalogue est indépendant de celui du marchand — un
    // marchand publie plusieurs catalogues au fil des jours.
    const catalogue = await service.createVisualCatalogues({
      handle: `cat-${crypto.randomUUID().slice(0, 10)}`,
      title: input.title,
      source_image_url: input.source_image_url,
    })

    for (const zone of input.zones) {
      await service.createCatalogueZones({
        catalogue_id: catalogue.id,
        x: zone.x,
        y: zone.y,
        width: zone.width,
        height: zone.height,
        detected_label: zone.label,
        detected_category: zone.category,
      })
    }

    return new StepResponse(catalogue, catalogue.id)
  },
  async (catalogueId: string | undefined, { container }) => {
    if (!catalogueId) return
    const service = container.resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
    await service.deleteVisualCatalogues([catalogueId])
  }
)
```

- [ ] **Step 5 : Écrire le workflow**

`src/workflows/analyze-catalogue-photo.ts` :

```ts
import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import { uploadFilesWorkflow, createRemoteLinkStep } from "@medusajs/medusa/core-flows"
import { MERCHANT_MODULE } from "../modules/merchant"
import { VISUAL_CATALOG_MODULE } from "../modules/visual-catalog"
import { detectProductsStep } from "./steps/detect-products"
import { createCatalogueDraftStep } from "./steps/create-catalogue-draft"

export type AnalyzeCataloguePhotoInput = {
  merchant_id: string
  filename: string
  content: string
  title: string
}

const analyzeCataloguePhotoWorkflow = createWorkflow(
  "analyze-catalogue-photo",
  (input: AnalyzeCataloguePhotoInput) => {
    const fichiers = uploadFilesWorkflow.runAsStep({
      input: {
        files: [
          transform(input, (i) => ({
            filename: i.filename,
            mimeType: "image/jpeg",
            content: i.content,
          })),
        ],
      },
    })

    const zones = detectProductsStep(
      transform(input, (i) => ({ content: i.content, filename: i.filename }))
    )

    const donneesBrouillon = transform(
      { input, fichiers, zones },
      (d) => ({
        title: d.input.title,
        source_image_url: d.fichiers[0].url,
        zones: d.zones,
      })
    )

    const catalogue = createCatalogueDraftStep(donneesBrouillon)

    createRemoteLinkStep([
      transform({ input, catalogue }, (d) => ({
        [MERCHANT_MODULE]: { merchant_id: d.input.merchant_id },
        [VISUAL_CATALOG_MODULE]: { visual_catalogue_id: d.catalogue.id },
      })),
    ])

    return new WorkflowResponse(
      transform({ catalogue, zones }, (d) => ({
        catalogue_id: d.catalogue.id,
        handle: d.catalogue.handle,
        zones: d.zones,
      }))
    )
  }
)

export default analyzeCataloguePhotoWorkflow
```

- [ ] **Step 6 : Lancer les tests et la vérification de types**

```bash
cd marketlens-commerce && npm run test:integration:http -- catalogue-analyze && npx tsc --noEmit -p tsconfig.json
```

Attendu : 1 test PASSÉ, `tsc` à zéro erreur.

- [ ] **Step 7 : Commit**

```bash
git add marketlens-commerce/src marketlens-commerce/integration-tests
git commit -m "feat(commerce): workflow d'analyse de photo, sans effet commercial"
```

---

### Task 6 : Workflow `publishCatalogue`

La transaction qui crée de la valeur : produits, variantes, prix, stock, liens, image annotée.

**Files:**
- Create: `marketlens-commerce/src/workflows/steps/annotate-catalogue.ts`
- Create: `marketlens-commerce/src/workflows/publish-catalogue.ts`
- Test: `marketlens-commerce/integration-tests/http/catalogue-publish.spec.ts`

**Interfaces:**
- Consumes: `analyzeCataloguePhotoWorkflow`, `assurerRegionXof`, `annoterImage`, `createProductsWorkflow`, `createInventoryLevelsWorkflow`, `createRemoteLinkStep`
- Produces: `publishCatalogueWorkflow` (export par défaut), entrée `{ catalogue_id: string; merchant_id: string; sales_channel_id: string; stock_location_id: string; items: ItemPublication[] }` où `ItemPublication = { zone_id: string; label: string; description?: string; price: string; quantity: number; colors: string[]; sizes: string[] }`, sortie `{ catalogue_id: string; product_ids: string[]; annotated_image_url: string }`.

- [ ] **Step 1 : Écrire les tests qui échouent**

`integration-tests/http/catalogue-publish.spec.ts` — deux tests : la publication nominale, et la compensation.

```ts
it("crée de vrais produits avec variantes, prix XOF et stock", async () => {
  // ... analyse préalable, puis :
  const { result } = await publishCatalogueWorkflow(getContainer()).run({
    input: {
      catalogue_id: brouillon.catalogue_id,
      merchant_id: m.merchant_id,
      sales_channel_id: m.sales_channel_id,
      stock_location_id: m.stock_location_id,
      items: [{
        zone_id: zones[0].id,
        label: "Tomates fraîches",
        price: "500",
        quantity: 12,
        colors: [],
        sizes: [],
      }, {
        zone_id: zones[1].id,
        label: "Pagne wax",
        price: "8000",
        quantity: 4,
        colors: ["Rouge", "Bleu"],
        sizes: ["M", "L"],
      }],
    },
  })

  expect(result.product_ids).toHaveLength(2)
  expect(result.annotated_image_url).toBeTruthy()

  const query = getContainer().resolve("query")
  const { data } = await query.graph({
    entity: "product",
    fields: ["id", "title", "variants.id", "variants.title"],
    filters: { id: result.product_ids },
  })

  const pagne = data.find((p) => p.title === "Pagne wax")
  // Deux couleurs × deux tailles = quatre variantes réelles, pas du texte libre.
  expect(pagne.variants).toHaveLength(4)

  const tomates = data.find((p) => p.title === "Tomates fraîches")
  expect(tomates.variants).toHaveLength(1)

  const service = getContainer().resolve(VISUAL_CATALOG_MODULE)
  const cat = await service.retrieveVisualCatalogue(brouillon.catalogue_id)
  expect(cat.status).toBe("published")
})
```

```ts
it("ne laisse aucun produit orphelin si l'annotation échoue en aval", async () => {
  // L'orchestrateur est strictement séquentiel : forcer l'échec sur la
  // PREMIÈRE étape ne prouverait rien, aucune suivante ne s'exécutant.
  // On fait donc échouer l'annotation, qui vient APRÈS la création des
  // produits — seule façon d'exercer réellement leur compensation.
  const avant = await compterProduits(getContainer())

  const vision = await servirVisionFactice({
    detect: { products: [ZONE_TOMATES], count: 1 },
    statutAnnotate: 502,
  })

  let aEchoue = false
  try {
    await publishCatalogueWorkflow(getContainer()).run({ input: entree })
  } catch {
    aEchoue = true   // les rejets de workflow ne sont pas des Error
  }
  expect(aEchoue).toBe(true)

  expect(await compterProduits(getContainer())).toBe(avant)
  const cat = await service.retrieveVisualCatalogue(catalogueId)
  expect(cat.status).toBe("draft")   // la publication n'a pas eu lieu
  await vision.fermer()
})
```

Étendre `helpers/vision-stub.ts` d'une option `statutAnnotate`.

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```bash
cd marketlens-commerce && npm run test:integration:http -- catalogue-publish
```

Attendu : ÉCHEC à la collecte, `Cannot find module '../../src/workflows/publish-catalogue'`.

- [ ] **Step 3 : Écrire l'étape d'annotation**

`src/workflows/steps/annotate-catalogue.ts` :

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ProduitAnnote, annoterImage } from "../../lib/vision-client"

export type AnnotateCatalogueInput = {
  content: string
  filename: string
  produits: ProduitAnnote[]
}

/** Lecture pure côté vision : rien à compenser. Le fichier annoté est
 *  déposé par l'étape suivante, qui porte sa propre compensation. */
export const annotateCatalogueStep = createStep(
  "annotate-catalogue",
  async (input: AnnotateCatalogueInput) => {
    const octets = await annoterImage(
      Buffer.from(input.content, "binary"),
      input.filename,
      input.produits
    )
    return new StepResponse(octets.toString("binary"))
  }
)
```

- [ ] **Step 4 : Ne pas écrire d'étape de liaison**

`createRemoteLinkStep`, déjà utilisé au plan 2, **porte sa propre compensation** : elle défait les liens créés en cas d'échec en aval. Écrire une étape maison pour lier zones et produits la dupliquerait sans rien apporter. Utilisez-la directement dans le workflow, avec un lien par zone :

```ts
    createRemoteLinkStep(
      transform({ items, produits }, (d) =>
        d.items.map((item, i) => ({
          [VISUAL_CATALOG_MODULE]: { catalogue_zone_id: item.zone_id },
          [Modules.PRODUCT]: { product_id: d.produits[i].id },
        }))
      )
    )
```

`ContainerRegistrationKeys.LINK` vaut `"link"` et `dismissRemoteLinkStep` existe également — vérifiés dans le paquet installé — mais aucun des deux n'est nécessaire ici.

- [ ] **Step 5 : Écrire le workflow de publication**

`src/workflows/publish-catalogue.ts` :

```ts
import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import {
  createProductsWorkflow,
  createInventoryLevelsWorkflow,
  createRemoteLinkStep,
  uploadFilesWorkflow,
} from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/framework/utils"
import { VISUAL_CATALOG_MODULE } from "../modules/visual-catalog"
import { annotateCatalogueStep } from "./steps/annotate-catalogue"
import { publierCatalogueStep } from "./steps/publier-catalogue"

export type ItemPublication = {
  zone_id: string
  label: string
  description?: string
  price: string
  quantity: number
  colors: string[]
  sizes: string[]
}

export type PublishCatalogueInput = {
  catalogue_id: string
  merchant_id: string
  sales_channel_id: string
  stock_location_id: string
  source_content: string
  source_filename: string
  zones: { id: string; x: number; y: number; width: number; height: number; category: string }[]
  items: ItemPublication[]
}

/** Produit cartésien des couleurs et tailles. Sans variante déclarée,
 *  Medusa exige tout de même une variante : on en crée une, unique. */
function variantesDe(item: ItemPublication) {
  const couleurs = item.colors.length ? item.colors : [null]
  const tailles = item.sizes.length ? item.sizes : [null]
  const combinaisons: { titre: string; options: Record<string, string> }[] = []

  for (const c of couleurs) {
    for (const t of tailles) {
      const options: Record<string, string> = {}
      if (c) options["Couleur"] = c
      if (t) options["Taille"] = t
      combinaisons.push({
        titre: [c, t].filter(Boolean).join(" / ") || "Unique",
        options,
      })
    }
  }
  return combinaisons
}

const publishCatalogueWorkflow = createWorkflow(
  "publish-catalogue",
  (input: PublishCatalogueInput) => {
    const donneesProduits = transform(input, (i) => ({
      products: i.items.map((item) => {
        const options: { title: string; values: string[] }[] = []
        if (item.colors.length) options.push({ title: "Couleur", values: item.colors })
        if (item.sizes.length) options.push({ title: "Taille", values: item.sizes })
        if (!options.length) options.push({ title: "Format", values: ["Unique"] })

        return {
          title: item.label,
          description: item.description ?? "",
          status: "published" as const,
          sales_channels: [{ id: i.sales_channel_id }],
          options,
          variants: variantesDe(item).map((v) => ({
            title: v.titre,
            options: Object.keys(v.options).length ? v.options : { Format: "Unique" },
            manage_inventory: true,
            prices: [{ amount: Number(item.price), currency_code: "xof" }],
          })),
        }
      }),
    }))

    const produits = createProductsWorkflow.runAsStep({ input: donneesProduits })

    // Les articles d'inventaire naissent avec les variantes ; on leur pose un
    // niveau à l'emplacement du marchand, seul endroit où son stock existe.
    const niveaux = transform({ input, produits }, (d) => ({
      inventory_levels: d.produits.flatMap((produit, i) =>
        produit.variants.flatMap((variante) =>
          (variante.inventory_items ?? []).map((article) => ({
            inventory_item_id: article.inventory_item_id,
            location_id: d.input.stock_location_id,
            stocked_quantity: d.input.items[i].quantity,
          }))
        )
      ),
    }))

    createInventoryLevelsWorkflow.runAsStep({ input: niveaux })

    createRemoteLinkStep(
      transform({ input, produits }, (d) =>
        d.input.items.map((item, i) => ({
          [VISUAL_CATALOG_MODULE]: { catalogue_zone_id: item.zone_id },
          [Modules.PRODUCT]: { product_id: d.produits[i].id },
        }))
      )
    )

    // L'annotation vient APRÈS la création des produits : c'est ce qui rend
    // le test de compensation capable d'exercer leur retour arrière.
    const annotee = annotateCatalogueStep(
      transform(input, (i) => ({
        content: i.source_content,
        filename: i.source_filename,
        produits: i.items.map((item) => {
          const zone = i.zones.find((z) => z.id === item.zone_id)!
          return {
            label: item.label,
            x: zone.x, y: zone.y, width: zone.width, height: zone.height,
            category: zone.category,
            price: item.price,
          }
        }),
      }))
    )

    const fichierAnnote = uploadFilesWorkflow.runAsStep({
      input: {
        files: [
          transform({ input, annotee }, (d) => ({
            filename: `annote-${d.input.source_filename}`,
            mimeType: "image/jpeg",
            content: d.annotee,
          })),
        ],
      },
    })

    const catalogue = publierCatalogueStep(
      transform({ input, fichierAnnote }, (d) => ({
        catalogue_id: d.input.catalogue_id,
        annotated_image_url: d.fichierAnnote[0].url,
      }))
    )

    return new WorkflowResponse(
      transform({ input, produits, catalogue }, (d) => ({
        catalogue_id: d.input.catalogue_id,
        product_ids: d.produits.map((p) => p.id),
        annotated_image_url: d.catalogue.annotated_image_url,
      }))
    )
  }
)

export default publishCatalogueWorkflow
```

`src/workflows/steps/publier-catalogue.ts` — le basculement en `published`, compensable :

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { VISUAL_CATALOG_MODULE } from "../../modules/visual-catalog"
import VisualCatalogModuleService from "../../modules/visual-catalog/service"

export type PublierCatalogueInput = {
  catalogue_id: string
  annotated_image_url: string
}

export const publierCatalogueStep = createStep(
  "publier-catalogue",
  async (input: PublierCatalogueInput, { container }) => {
    const service = container.resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
    const avant = await service.retrieveVisualCatalogue(input.catalogue_id)

    const apres = await service.updateVisualCatalogues({
      id: input.catalogue_id,
      annotated_image_url: input.annotated_image_url,
      status: "published",
    })

    // La compensation restaure l'état exact d'avant, pas un état supposé.
    return new StepResponse(apres, {
      catalogue_id: input.catalogue_id,
      status: avant.status,
      annotated_image_url: avant.annotated_image_url,
    })
  },
  async (etatPrecedent, { container }) => {
    if (!etatPrecedent) return
    const service = container.resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
    await service.updateVisualCatalogues({
      id: etatPrecedent.catalogue_id,
      status: etatPrecedent.status,
      annotated_image_url: etatPrecedent.annotated_image_url,
    })
  }
)
```

**Appelez `assurerRegionXof(container)` depuis la route, avant de lancer le workflow** — c'est une lecture-ou-création idempotente, elle n'a pas sa place dans une transaction compensable.

**Points de vigilance :**
- Un item sans couleur ni taille produit **un** produit à variante unique, avec une option de repli `Format: Unique` — Medusa exige au moins une option.
- Un item à deux couleurs et deux tailles produit **quatre** variantes, chacune avec son prix et son niveau de stock.
- La quantité s'applique **par variante**, non répartie entre elles. Un marchand qui saisit « 4 pagnes » obtiendra donc 4 exemplaires de chacune des 4 variantes, soit 16. Si ce comportement vous paraît faux, dites-le dans votre rapport : c'est une décision produit, pas technique, et elle mérite d'être tranchée plutôt que subie.

- [ ] **Step 6 : Lancer les tests et la vérification de types**

```bash
cd marketlens-commerce && npm run test:integration:http -- catalogue-publish && npx tsc --noEmit -p tsconfig.json
```

Attendu : 2 tests PASSÉS.

- [ ] **Step 7 : Prouver la compensation par un rouge/vert**

Retirez temporairement la compensation de `linkZonesToProductsStep`, constatez que le test de compensation devient **rouge**, remettez-la, constatez le **vert**. **Consignez les deux sorties dans votre rapport.** Un test de compensation qu'on n'a jamais vu échouer ne prouve rien.

- [ ] **Step 8 : Commit**

```bash
git add marketlens-commerce/src marketlens-commerce/integration-tests
git commit -m "feat(commerce): publication d'un catalogue en produits Medusa"
```

---

### Task 7 : Routes marchand et vitrine

**Files:**
- Create: `marketlens-commerce/src/api/merchant/catalogues/route.ts`
- Create: `marketlens-commerce/src/api/merchant/catalogues/[id]/publish/route.ts`
- Create: `marketlens-commerce/src/api/store/catalogues/[handle]/route.ts`
- Test: `marketlens-commerce/integration-tests/http/catalogue-store.spec.ts`

**Interfaces:**
- Consumes: `analyzeCataloguePhotoWorkflow`, `publishCatalogueWorkflow`
- Produces: `POST /merchant/catalogues` (multipart, champ `image` + `title`) → `{ catalogue: { id, handle, status }, zones: [...] }` ; `GET /merchant/catalogues` → les catalogues **du marchand du jeton uniquement** ; `POST /merchant/catalogues/:id/publish` (corps `{ items: [...] }`) → `{ catalogue_id, product_ids, annotated_image_url }` ; `GET /store/catalogues/:handle` → `{ catalogue: { handle, title, annotated_image_url }, zones: [{ x, y, width, height, product: { id, title, variants } }] }`.

- [ ] **Step 1 : Écrire le test d'isolation des catalogues**

C'est le test qui compte ici. Deux marchands, un catalogue chacun.

```ts
it("un marchand ne voit ni ne publie le catalogue d'un autre", async () => {
  const a = await inscrireEtAnalyser(api, "etal-cat-a", "22990009001")
  const b = await inscrireEtAnalyser(api, "etal-cat-b", "22990009002")

  // Liste : chacun ne voit que le sien
  const listeA = await api.get("/merchant/catalogues",
    { headers: { authorization: `Bearer ${a.jeton}` } })
  expect(listeA.data.catalogues.map((c) => c.id)).toEqual([a.catalogueId])
  expect(listeA.data.catalogues.map((c) => c.id)).not.toContain(b.catalogueId)

  // Publication croisée : A ne doit pas pouvoir publier le catalogue de B
  const croise = await api.post(
    `/merchant/catalogues/${b.catalogueId}/publish`,
    { items: [] },
    { headers: { authorization: `Bearer ${a.jeton}` } }
  ).catch((e) => e.response)
  expect(croise.status).toBe(404)
})
```

Le 404 plutôt qu'un 403 est délibéré : un 403 confirmerait à A que ce catalogue existe.

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

```bash
cd marketlens-commerce && npm run test:integration:http -- catalogue-store
```

Attendu : ÉCHEC — les routes renvoient 404 parce qu'elles n'existent pas encore. **Distinguez ce 404-là de celui qu'attend l'assertion** : le test doit d'abord échouer sur la liste, pas sur la publication croisée.

- [ ] **Step 3 : Écrire les routes marchand**

Un assistant partagé porte la règle de portée. **Écrivez-le une fois** — les trois routes marchand l'utilisent, et c'est le seul endroit où se décide qui voit quoi.

`src/api/merchant/catalogues/scope.ts` :

```ts
import { MedusaContainer } from "@medusajs/framework/types"

/**
 * Rend les catalogues du marchand porté par le jeton, et rien d'autre.
 * `merchantId` vient toujours de `req.auth_context.actor_id`, jamais du
 * corps ni de l'URL : c'est ce qui rend le cloisonnement structurel.
 */
export async function cataloguesDuMarchand(
  container: MedusaContainer,
  merchantId: string
): Promise<{ id: string; handle: string; title: string; status: string }[]> {
  const query = container.resolve("query")
  const { data } = await query.graph({
    entity: "merchant",
    fields: ["id", "visual_catalogues.*"],
    filters: { id: merchantId },
  })
  return data[0]?.visual_catalogues ?? []
}

/** `null` si le catalogue n'existe pas OU n'appartient pas à ce marchand :
 *  les deux cas doivent être indiscernables pour l'appelant. */
export async function catalogueDuMarchand(
  container: MedusaContainer,
  merchantId: string,
  catalogueId: string
) {
  const catalogues = await cataloguesDuMarchand(container, merchantId)
  return catalogues.find((c) => c.id === catalogueId) ?? null
}
```

`src/api/merchant/catalogues/route.ts` :

```ts
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import analyzeCataloguePhotoWorkflow from "../../../workflows/analyze-catalogue-photo"
import { cataloguesDuMarchand } from "./scope"

export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const catalogues = await cataloguesDuMarchand(req.scope, req.auth_context.actor_id)
  res.json({ catalogues })
}

export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const fichier = (req as any).files?.[0]
  if (!fichier) {
    return res.status(400).json({ message: "Une image est obligatoire" })
  }

  const { result } = await analyzeCataloguePhotoWorkflow(req.scope).run({
    input: {
      merchant_id: req.auth_context.actor_id,
      filename: fichier.originalname,
      content: fichier.buffer.toString("binary"),
      title: (req.body as any)?.title || "Catalogue sans titre",
    },
  })

  res.json({
    catalogue: { id: result.catalogue_id, handle: result.handle, status: "draft" },
    zones: result.zones,
  })
}
```

L'envoi multipart passe par le middleware `upload` de Medusa. Déclarez-le dans `src/api/middlewares.ts`, **après** les règles d'authentification de `/merchant/*` :

```ts
    {
      matcher: "/merchant/catalogues",
      methods: ["POST"],
      middlewares: [upload.array("image")],
    },
```

`src/api/merchant/catalogues/[id]/publish/route.ts` :

```ts
import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import publishCatalogueWorkflow from "../../../../../workflows/publish-catalogue"
import { assurerRegionXof } from "../../../../../workflows/ensure-region"
import { catalogueDuMarchand } from "../../scope"

export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  const merchantId = req.auth_context.actor_id
  const catalogue = await catalogueDuMarchand(req.scope, merchantId, req.params.id)

  if (!catalogue) {
    // 404 et non 403 : un 403 confirmerait l'existence du catalogue d'autrui.
    return res.status(404).json({ message: "Catalogue introuvable" })
  }
  if (catalogue.status === "published") {
    return res.status(409).json({ message: "Ce catalogue est déjà publié" })
  }

  await assurerRegionXof(req.scope)

  const { result } = await publishCatalogueWorkflow(req.scope).run({
    input: { ...(req.body as any), catalogue_id: catalogue.id, merchant_id: merchantId },
  })

  res.json(result)
}
```

Le corps de la requête ne peut **jamais** imposer `catalogue_id` ni `merchant_id` : les deux sont réécrits après le `spread`, depuis le jeton et depuis le catalogue vérifié.

- [ ] **Step 4 : Écrire la route vitrine**

`src/api/store/catalogues/[handle]/route.ts` — **publique**, c'est le lien qu'un marchand partage :

```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve("query")

  const { data } = await query.graph({
    entity: "visual_catalogue",
    fields: [
      "id", "handle", "title", "annotated_image_url", "status",
      "zones.id", "zones.x", "zones.y", "zones.width", "zones.height",
      "zones.detected_label", "zones.detected_category",
      "zones.product.id", "zones.product.title", "zones.product.description",
      "zones.product.variants.id", "zones.product.variants.title",
    ],
    filters: { handle: req.params.handle, status: "published" },
  })

  const catalogue = data[0]
  if (!catalogue) {
    // Un brouillon est indiscernable d'un catalogue inexistant : le filtre
    // `status: "published"` fait partie du cloisonnement, pas du confort.
    return res.status(404).json({ message: "Catalogue introuvable" })
  }

  res.json({
    catalogue: {
      handle: catalogue.handle,
      title: catalogue.title,
      // `source_image_url` n'est jamais exposé : la vitrine ne montre que
      // l'image annotée, celle que le marchand a validée.
      annotated_image_url: catalogue.annotated_image_url,
    },
    zones: catalogue.zones,
  })
}
```

**Vérifiez le nom réel du champ de lien zone → produit** avant d'écrire `zones.product.*` : la tâche 3 vous a demandé de le consigner. S'il diffère, adaptez plutôt que de forcer.

- [ ] **Step 5 : Lancer la suite complète et la vérification de types**

```bash
cd marketlens-commerce && npm run test:integration:http && npm run test:integration:modules && npx tsc --noEmit -p tsconfig.json
```

- [ ] **Step 6 : Commit**

```bash
git add marketlens-commerce/src/api marketlens-commerce/integration-tests
git commit -m "feat(commerce): routes de catalogue marchand et vitrine publique"
```

---

### Task 8 : Import du corpus existant

Les 28 catalogues archivés ne sont pas un patrimoine à sauver : **ils prouvent que le nouveau modèle sait représenter tout ce que l'ancien représentait.** Un catalogue qui ne passe pas révèle un trou.

**Files:**
- Create: `marketlens-commerce/src/scripts/seed-legacy.ts`
- Modify: `marketlens-commerce/package.json` (script `seed:legacy`)

**Interfaces:**
- Consumes: `createMerchantWorkflow`, `analyzeCataloguePhotoWorkflow`, `publishCatalogueWorkflow`
- Produces: `npm run seed:legacy -- <chemin-archive>` — importe l'archive, sans appeler Gemini

- [ ] **Step 1 : Écrire le script**

`src/scripts/seed-legacy.ts`, exécuté par `medusa exec` :

```ts
import fs from "fs"
import path from "path"
import { ExecArgs } from "@medusajs/framework/types"
import createMerchantWorkflow from "../workflows/create-merchant"
import { createCatalogueDraftStep } from "../workflows/steps/create-catalogue-draft"
import publishCatalogueWorkflow from "../workflows/publish-catalogue"
import { assurerRegionXof } from "../workflows/ensure-region"

type ProduitLegacy = {
  label: string; x: number; y: number; width: number; height: number
  category: string; description?: string; price?: string
  colors?: string[]; sizes?: string[]
}

type MetadataLegacy = {
  id: string; products: ProduitLegacy[]
  merchant_name?: string; merchant_phone?: string; merchant_whatsapp?: string
}

function slug(brut: string): string {
  return brut.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "marchand"
}

export default async function seedLegacy({ container, args }: ExecArgs) {
  const archive = args[0]
  if (!archive) throw new Error("Usage : seed:legacy -- <chemin-archive>")

  const racine = path.join(archive, "catalogues")
  const dossiers = fs.readdirSync(racine)
  await assurerRegionXof(container)

  const marchandsParTelephone = new Map<string, any>()
  const echecs: { catalogue: string; raison: string }[] = []
  let importes = 0

  for (const dossier of dossiers) {
    const chemin = path.join(racine, dossier)
    try {
      const meta: MetadataLegacy = JSON.parse(
        fs.readFileSync(path.join(chemin, "metadata.json"), "utf-8")
      )
      const telephone = meta.merchant_phone || `inconnu-${dossier}`

      if (!marchandsParTelephone.has(telephone)) {
        const { result } = await createMerchantWorkflow(container).run({
          input: {
            name: meta.merchant_name || "Marchand sans nom",
            handle: `legacy-${slug(meta.merchant_name || dossier)}-${dossier.slice(0, 4)}`,
            phone: telephone,
            whatsapp_phone: meta.merchant_whatsapp || undefined,
          },
        })
        marchandsParTelephone.set(telephone, result)
      }
      const marchand = marchandsParTelephone.get(telephone)

      // La détection est court-circuitée : les zones viennent du fichier,
      // pas de Gemini. Aucun appel réseau, donc aucun coût ni non-déterminisme.
      const octets = fs.readFileSync(path.join(chemin, "original.jpg"))
      const { result: fichiers } = await (
        await import("@medusajs/medusa/core-flows")
      ).uploadFilesWorkflow(container).run({
        input: { files: [{
          filename: `${dossier}.jpg`, mimeType: "image/jpeg",
          content: octets.toString("binary"),
        }] },
      })

      const { result: brouillon } = await createCatalogueDraftStep.run({
        input: {
          title: `Catalogue ${dossier}`,
          source_image_url: fichiers[0].url,
          zones: meta.products.map((p) => ({
            label: p.label, x: p.x, y: p.y, width: p.width,
            height: p.height, category: p.category,
          })),
        },
        container,
      })

      const zones = await container
        .resolve("visual_catalog")
        .listCatalogueZones({ catalogue_id: brouillon.id })

      await publishCatalogueWorkflow(container).run({
        input: {
          catalogue_id: brouillon.id,
          merchant_id: marchand.merchant_id,
          sales_channel_id: marchand.sales_channel_id,
          stock_location_id: marchand.stock_location_id,
          source_content: octets.toString("binary"),
          source_filename: `${dossier}.jpg`,
          zones,
          items: meta.products
            .filter((p) => p.price)
            .map((p, i) => ({
              zone_id: zones[i].id,
              label: p.label,
              description: p.description,
              price: p.price!,
              quantity: 1,
              colors: p.colors ?? [],
              sizes: p.sizes ?? [],
            })),
        },
      })
      importes++
    } catch (e) {
      echecs.push({ catalogue: dossier, raison: (e as Error).message ?? String(e) })
    }
  }

  console.log(`\n${importes} catalogues importés, ${marchandsParTelephone.size} marchands créés`)
  if (echecs.length) {
    console.log(`\n${echecs.length} ÉCHECS — chacun révèle un champ que le nouveau modèle n'accueille pas :`)
    for (const e of echecs) console.log(`  ${e.catalogue} : ${e.raison}`)
  }
}
```

Ajouter à `package.json` : `"seed:legacy": "medusa exec ./src/scripts/seed-legacy.ts"`.

**Le catalogue `a63c379117` n'était pas suivi par git** — il n'existe que dans l'archive. S'il manque, l'archive est incomplète : arrêtez-vous et signalez-le.

- [ ] **Step 2 : Lancer l'import sur l'archive réelle**

```bash
cd marketlens-commerce && npm run seed:legacy -- ../../marketlens-archive
```

Attendu : 28 catalogues traités. **Si certains échouent, ne les écartez pas** — consignez chaque échec et sa cause dans votre rapport. Un champ que l'ancien modèle portait et que le nouveau ne sait pas accueillir est un défaut de conception à remonter, pas une donnée à ignorer.

- [ ] **Step 3 : Vérifier l'isolation sur les données réelles importées**

Ajouter à la fin de `seed-legacy.ts`, avant le rapport final :

```ts
  // L'isolation est prouvée par les tests sur des données fabriquées. Ici
  // elle est vérifiée sur le corpus réel, où les marchands ont des noms,
  // des téléphones et des produits qui n'ont pas été choisis pour le test.
  const marchands = [...marchandsParTelephone.values()]
  if (marchands.length >= 2) {
    const query = container.resolve("query")
    const canaux = await Promise.all(
      marchands.slice(0, 2).map(async (m) => {
        const { data } = await query.graph({
          entity: "product",
          fields: ["id", "title"],
          filters: { sales_channel_id: m.sales_channel_id },
        })
        return { marchand: m.merchant_id, produits: data.map((p) => p.id) }
      })
    )
    const croisement = canaux[0].produits.filter((id) => canaux[1].produits.includes(id))
    if (croisement.length) {
      throw new Error(
        `ISOLATION ROMPUE : ${croisement.length} produits visibles depuis deux canaux`
      )
    }
    console.log(
      `Isolation vérifiée sur le corpus : ${canaux[0].produits.length} et ` +
      `${canaux[1].produits.length} produits, aucun croisement`
    )
  }
```

**Si cette vérification lève, arrêtez tout et rapportez.** Un croisement sur des données réelles invalide le lot entier, quels que soient les tests verts.

- [ ] **Step 4 : Commit**

```bash
git add marketlens-commerce/src/scripts marketlens-commerce/package.json
git commit -m "feat(commerce): import du corpus archivé comme validation du modèle"
```

---

## Vérification finale du plan

- [ ] `npm run test:integration:modules` et `npm run test:integration:http` verts
- [ ] `npx tsc --noEmit -p tsconfig.json` à zéro erreur
- [ ] Une photo devient un brouillon sans créer aucun produit
- [ ] Une publication crée produits, variantes, prix XOF, stock et image annotée
- [ ] La compensation a été vue rouge puis verte
- [ ] Un marchand ne voit ni ne publie le catalogue d'un autre
- [ ] Les 28 catalogues du corpus sont importés, ou leurs échecs sont documentés
- [ ] Aucune collection ni catégorie Medusa n'est utilisée pour regrouper par marchand

## Ce que ce plan ne fait pas

Aucune interface. Le back-office marchand et la vitrine cliquable relèvent du **plan 4** : ce plan produit l'API et les preuves.

Le paiement reste le *manual payment provider* ; le vrai mobile money est le **lot 2** de la spec. Les notifications WhatsApp sont le **lot 3**, l'inventaire par re-photographie le **lot 4**.

Restent ouverts, sans bloquer : l'admin Medusa natif donne toujours accès à toutes les données de tous les marchands, et la garde 413 du service de vision ne protège rien tant qu'un reverse-proxy ne borne pas le corps en amont. Les deux sont à traiter avant toute mise en ligne, pas avant le plan 4.
