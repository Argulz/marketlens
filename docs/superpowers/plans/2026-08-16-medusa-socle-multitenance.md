# Socle Medusa et multi-tenance marchand — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provisionner un marchand isolé dans Medusa, lui permettre de s'authentifier, et **prouver par des tests** qu'aucune donnée ne fuit d'un marchand à l'autre.

**Architecture:** Un module `merchant` porte l'entité pivot. L'isolation repose sur trois mécanismes natifs de Medusa : un *sales channel* par marchand (filtrage de la Store API par clé publiable, appliqué par le framework), une *stock location* par marchand (cloisonnement des stocks), et un **type d'acteur d'authentification custom** `merchant` qui protège les routes `/merchant/*`. Les rattachements passent par des *module links*, jamais par clé étrangère inter-modules.

**Tech Stack:** Medusa 2.18.0, Node 20+, PostgreSQL 16, TypeScript, Jest via `@medusajs/test-utils`.

**Spec:** `docs/superpowers/specs/2026-08-16-marketlens-medusa-socle-design.md`

## Vérité terrain établie avant ce plan

Le socle est **déjà installé et vérifié** (commit `2d04cc2`). Ce plan démarre là, pas à zéro.

| Élément | État vérifié |
|---|---|
| Medusa | 2.18.0, versions épinglées à l'exact |
| PostgreSQL | 16 en conteneur, port **5440** (5432–5435 occupés par une autre pile sur cette machine) |
| Migrations | passées ; `/health` répond 200 sur le port 9000 |
| Compte opérateur | `admin@marketlens.local` |

Les API dont ce plan dépend ont été vérifiées présentes dans le paquet installé, pas supposées :

- `defineLink`, `MedusaService`, `Module`, `model` — `@medusajs/framework/utils`
- `authenticate(actorType: string | string[], authType, options?)` — `@medusajs/framework/http`, `actorType` est une **chaîne libre**, et `options.allowUnregistered` existe
- `defineMiddlewares` — `@medusajs/framework/http`
- `createSalesChannelsWorkflow`, `createStockLocationsWorkflow`, `createApiKeysWorkflow`, `linkSalesChannelsToApiKeyWorkflow`, `linkSalesChannelsToStockLocationWorkflow`, `createProductsWorkflow`, `setAuthAppMetadataStep` — `@medusajs/medusa/core-flows`
- `setAuthAppMetadataStepInput = { authIdentityId: string; actorType: string; value: string | null }`
- Routes génériques `/auth/[actor_type]/[auth_provider]/register` et login — **`POST /auth/merchant/emailpass/register` fonctionne sans code d'authentification à écrire**
- `medusaIntegrationTestRunner`, `moduleIntegrationTestRunner` — `@medusajs/test-utils`

## Global Constraints

- Travailler depuis `marketlens-commerce/`. Commandes : `npx medusa …`, `npm run test:integration:modules`, `npm run test:integration:http`.
- **Jamais de clé étrangère entre modules.** Les rattachements inter-modules passent par `defineLink` dans `src/links/`.
- Devise par défaut : **`xof`** (minuscules — Medusa normalise les codes devise en minuscules).
- Un marchand à moitié provisionné est un **état interdit** : chaque étape du workflow porte sa compensation.
- L'admin Medusa natif n'est **jamais** exposé à un marchand. Il reste à l'opérateur de la plateforme.
- Aucun test ne doit dépendre de l'ordre d'exécution ni d'un état laissé par un autre test.
- **Indexer par chemins explicites, jamais `git add -A` à la racine** : `hackathon_scenai_vision.md` traîne non suivi et appartient à un autre projet.
- Messages d'erreur destinés à l'utilisateur en français.

## Structure de fichiers

```
marketlens-commerce/
├── medusa-config.ts                       # enregistrement du module merchant
├── src/
│   ├── modules/merchant/
│   │   ├── models/merchant.ts             # entité Merchant (DML)
│   │   ├── service.ts                     # MerchantModuleService
│   │   └── index.ts                       # Module() + MERCHANT_MODULE
│   ├── links/
│   │   ├── merchant-sales-channel.ts
│   │   ├── merchant-stock-location.ts
│   │   └── merchant-api-key.ts
│   ├── workflows/
│   │   ├── create-merchant.ts             # workflow de provisionnement
│   │   └── steps/create-merchant-record.ts
│   ├── api/
│   │   ├── middlewares.ts                 # portée et authentification des routes /merchant/*
│   │   └── merchant/
│   │       ├── register/route.ts
│   │       └── me/route.ts
└── integration-tests/
    ├── modules/merchant.spec.ts
    └── http/
        ├── merchant-provisioning.spec.ts
        └── merchant-isolation.spec.ts     # LE test de sécurité
```

`models/` ne connaît que la forme des données ; `service.ts` ne connaît pas HTTP ; les routes ne contiennent aucune logique de provisionnement, elles délèguent au workflow.

---

### Task 1 : Module `merchant`

**Files:**
- Create: `marketlens-commerce/src/modules/merchant/models/merchant.ts`
- Create: `marketlens-commerce/src/modules/merchant/service.ts`
- Create: `marketlens-commerce/src/modules/merchant/index.ts`
- Modify: `marketlens-commerce/medusa-config.ts`
- Test: `marketlens-commerce/integration-tests/modules/merchant.spec.ts`

**Interfaces:**
- Consumes: rien
- Produces: `MERCHANT_MODULE = "merchant"` (export nommé de `src/modules/merchant/index.ts`) ; `MerchantModuleService` avec les méthodes générées par `MedusaService` : `createMerchants(data)`, `listMerchants(filters)`, `retrieveMerchant(id)`, `updateMerchants(data)`, `deleteMerchants(ids)`. Entité `Merchant` aux champs `id`, `name`, `handle`, `phone`, `whatsapp_phone`, `currency_code`, `status`.

- [ ] **Step 1 : Écrire le test de module qui échoue**

`marketlens-commerce/integration-tests/modules/merchant.spec.ts` :

```ts
import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { MERCHANT_MODULE } from "../../src/modules/merchant"
import MerchantModuleService from "../../src/modules/merchant/service"
import { Merchant } from "../../src/modules/merchant/models/merchant"

moduleIntegrationTestRunner<MerchantModuleService>({
  moduleName: MERCHANT_MODULE,
  moduleModels: [Merchant],
  testSuite: ({ service }) => {
    describe("MerchantModuleService", () => {
      it("crée un marchand avec les valeurs par défaut attendues", async () => {
        const marchand = await service.createMerchants({
          name: "Étal de Fatou",
          handle: "etal-de-fatou",
          phone: "22990000001",
        })

        expect(marchand.id).toBeTruthy()
        expect(marchand.currency_code).toBe("xof")
        expect(marchand.status).toBe("pending")
        expect(marchand.whatsapp_phone).toBeNull()
      })

      it("refuse deux marchands portant le même handle", async () => {
        await service.createMerchants({
          name: "Étal A", handle: "doublon", phone: "22990000002",
        })

        await expect(
          service.createMerchants({
            name: "Étal B", handle: "doublon", phone: "22990000003",
          })
        ).rejects.toThrow()
      })

      it("retrouve un marchand par son handle", async () => {
        await service.createMerchants({
          name: "Étal de Kofi", handle: "etal-de-kofi", phone: "22990000004",
        })

        const [trouve] = await service.listMerchants({ handle: "etal-de-kofi" })
        expect(trouve.name).toBe("Étal de Kofi")
      })
    })
  },
})
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

```bash
cd marketlens-commerce && npm run test:integration:modules
```

Attendu : ÉCHEC à la collecte — `Cannot find module '../../src/modules/merchant'`.

- [ ] **Step 3 : Écrire le modèle**

`marketlens-commerce/src/modules/merchant/models/merchant.ts` :

```ts
import { model } from "@medusajs/framework/utils"

export const Merchant = model.define("merchant", {
  id: model.id().primaryKey(),
  name: model.text(),
  handle: model.text().unique(),
  phone: model.text(),
  whatsapp_phone: model.text().nullable(),
  currency_code: model.text().default("xof"),
  status: model.enum(["pending", "active", "suspended"]).default("pending"),
})
```

Aucune colonne `sales_channel_id`, `stock_location_id` ni `publishable_key_id` : ces rattachements sont des *module links*, créés à la tâche 2. Une colonne d'identifiant vers un autre module serait une clé étrangère déguisée.

- [ ] **Step 4 : Écrire le service et l'enregistrement du module**

`marketlens-commerce/src/modules/merchant/service.ts` :

```ts
import { MedusaService } from "@medusajs/framework/utils"
import { Merchant } from "./models/merchant"

class MerchantModuleService extends MedusaService({ Merchant }) {}

export default MerchantModuleService
```

`marketlens-commerce/src/modules/merchant/index.ts` :

```ts
import { Module } from "@medusajs/framework/utils"
import MerchantModuleService from "./service"

export const MERCHANT_MODULE = "merchant"

export default Module(MERCHANT_MODULE, {
  service: MerchantModuleService,
})
```

- [ ] **Step 5 : Enregistrer le module dans la configuration**

Dans `marketlens-commerce/medusa-config.ts`, ajouter la clé `modules` à l'objet passé à `defineConfig`, après `projectConfig` :

```ts
  modules: [
    {
      resolve: "./src/modules/merchant",
    },
  ],
```

- [ ] **Step 6 : Générer et appliquer la migration**

```bash
cd marketlens-commerce && npx medusa db:generate merchant && npx medusa db:migrate
```

Attendu : un fichier apparaît sous `src/modules/merchant/migrations/`, puis `Migrations completed`.

- [ ] **Step 7 : Lancer le test pour vérifier qu'il passe**

```bash
cd marketlens-commerce && npm run test:integration:modules
```

Attendu : 3 tests PASSÉS.

- [ ] **Step 8 : Commit**

```bash
git add marketlens-commerce/src/modules marketlens-commerce/medusa-config.ts marketlens-commerce/integration-tests
git commit -m "feat(commerce): module merchant, entité pivot de la multi-tenance"
```

---

### Task 2 : Workflow de provisionnement d'un marchand

Un marchand n'est pas seulement une ligne en base : c'est un sales channel, une stock location, une clé publiable, et les liens entre eux. Tout ou rien.

**Files:**
- Create: `marketlens-commerce/src/workflows/steps/create-merchant-record.ts`
- Create: `marketlens-commerce/src/workflows/create-merchant.ts`
- Create: `marketlens-commerce/src/links/merchant-sales-channel.ts`
- Create: `marketlens-commerce/src/links/merchant-stock-location.ts`
- Create: `marketlens-commerce/src/links/merchant-api-key.ts`
- Test: `marketlens-commerce/integration-tests/http/merchant-provisioning.spec.ts`

**Interfaces:**
- Consumes: `MERCHANT_MODULE`, `MerchantModuleService` (tâche 1)
- Produces: `createMerchantWorkflow` (export par défaut de `src/workflows/create-merchant.ts`), d'entrée `{ name: string; handle: string; phone: string; whatsapp_phone?: string }` et de sortie `{ merchant_id: string; sales_channel_id: string; stock_location_id: string; publishable_key: string }` — `publishable_key` est le **token** de la clé, pas son identifiant, car c'est lui que la vitrine enverra en en-tête `x-publishable-api-key`.

- [ ] **Step 1 : Écrire le test qui échoue**

`marketlens-commerce/integration-tests/http/merchant-provisioning.spec.ts` :

```ts
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import createMerchantWorkflow from "../../src/workflows/create-merchant"
import { MERCHANT_MODULE } from "../../src/modules/merchant"

jest.setTimeout(60 * 1000)

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    describe("createMerchantWorkflow", () => {
      it("provisionne un marchand complet", async () => {
        const { result } = await createMerchantWorkflow(getContainer()).run({
          input: {
            name: "Étal de Fatou",
            handle: "etal-de-fatou",
            phone: "22990000001",
          },
        })

        expect(result.merchant_id).toBeTruthy()
        expect(result.sales_channel_id).toBeTruthy()
        expect(result.stock_location_id).toBeTruthy()
        expect(result.publishable_key).toMatch(/^pk_/)
      })

      it("ne laisse aucun marchand orphelin si une étape échoue", async () => {
        // Un handle déjà pris fait échouer la première étape ; on vérifie
        // ensuite qu'aucune ressource n'a été laissée derrière.
        await createMerchantWorkflow(getContainer()).run({
          input: { name: "Premier", handle: "collision", phone: "22990000010" },
        })

        await expect(
          createMerchantWorkflow(getContainer()).run({
            input: { name: "Second", handle: "collision", phone: "22990000011" },
          })
        ).rejects.toThrow()

        const service = getContainer().resolve(MERCHANT_MODULE)
        const marchands = await service.listMerchants({ handle: "collision" })
        expect(marchands).toHaveLength(1)
      })
    })
  },
})
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

```bash
cd marketlens-commerce && npm run test:integration:http
```

Attendu : ÉCHEC à la collecte — `Cannot find module '../../src/workflows/create-merchant'`.

- [ ] **Step 3 : Écrire l'étape de création du marchand, avec sa compensation**

`marketlens-commerce/src/workflows/steps/create-merchant-record.ts` :

```ts
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { MERCHANT_MODULE } from "../../modules/merchant"

export type CreateMerchantRecordInput = {
  name: string
  handle: string
  phone: string
  whatsapp_phone?: string
}

export const createMerchantRecordStep = createStep(
  "create-merchant-record",
  async (input: CreateMerchantRecordInput, { container }) => {
    const service: any = container.resolve(MERCHANT_MODULE)
    const marchand = await service.createMerchants({
      name: input.name,
      handle: input.handle,
      phone: input.phone,
      whatsapp_phone: input.whatsapp_phone ?? null,
    })
    return new StepResponse(marchand, marchand.id)
  },
  async (merchantId: string | undefined, { container }) => {
    if (!merchantId) return
    const service: any = container.resolve(MERCHANT_MODULE)
    await service.deleteMerchants([merchantId])
  }
)
```

Le second argument de `StepResponse` est ce que reçoit la compensation. Sans lui, un échec en aval laisserait le marchand en base.

- [ ] **Step 4 : Écrire le workflow**

`marketlens-commerce/src/workflows/create-merchant.ts` :

```ts
import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import {
  createSalesChannelsWorkflow,
  createStockLocationsWorkflow,
  createApiKeysWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  createRemoteLinkStep,
} from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/framework/utils"
import { MERCHANT_MODULE } from "../modules/merchant"
import { createMerchantRecordStep, CreateMerchantRecordInput } from "./steps/create-merchant-record"

const createMerchantWorkflow = createWorkflow(
  "create-merchant",
  (input: CreateMerchantRecordInput) => {
    const marchand = createMerchantRecordStep(input)

    const salesChannels = createSalesChannelsWorkflow.runAsStep({
      input: { salesChannelsData: [{ name: `Boutique ${input.name}` }] },
    })

    const stockLocations = createStockLocationsWorkflow.runAsStep({
      input: { locations: [{ name: `Étal ${input.name}` }] },
    })

    const apiKeys = createApiKeysWorkflow.runAsStep({
      input: {
        api_keys: [
          { title: `Vitrine ${input.name}`, type: "publishable", created_by: "system" },
        ],
      },
    })

    const ids = transform(
      { marchand, salesChannels, stockLocations, apiKeys },
      (d) => ({
        merchant_id: d.marchand.id,
        sales_channel_id: d.salesChannels[0].id,
        stock_location_id: d.stockLocations[0].id,
        api_key_id: d.apiKeys[0].id,
        publishable_key: d.apiKeys[0].token,
      })
    )

    linkSalesChannelsToApiKeyWorkflow.runAsStep({
      input: { id: ids.api_key_id, add: [ids.sales_channel_id] },
    })

    linkSalesChannelsToStockLocationWorkflow.runAsStep({
      input: { id: ids.stock_location_id, add: [ids.sales_channel_id] },
    })

    createRemoteLinkStep([
      {
        [MERCHANT_MODULE]: { merchant_id: ids.merchant_id },
        [Modules.SALES_CHANNEL]: { sales_channel_id: ids.sales_channel_id },
      },
      {
        [MERCHANT_MODULE]: { merchant_id: ids.merchant_id },
        [Modules.STOCK_LOCATION]: { stock_location_id: ids.stock_location_id },
      },
      {
        [MERCHANT_MODULE]: { merchant_id: ids.merchant_id },
        [Modules.API_KEY]: { api_key_id: ids.api_key_id },
      },
    ])

    return new WorkflowResponse(ids)
  }
)

export default createMerchantWorkflow
```

- [ ] **Step 5 : Déclarer les liens de modules**

`marketlens-commerce/src/links/merchant-sales-channel.ts` :

```ts
import { defineLink } from "@medusajs/framework/utils"
import MerchantModule from "../modules/merchant"
import SalesChannelModule from "@medusajs/medusa/sales-channel"

export default defineLink(
  MerchantModule.linkable.merchant,
  SalesChannelModule.linkable.salesChannel
)
```

`marketlens-commerce/src/links/merchant-stock-location.ts` :

```ts
import { defineLink } from "@medusajs/framework/utils"
import MerchantModule from "../modules/merchant"
import StockLocationModule from "@medusajs/medusa/stock-location"

export default defineLink(
  MerchantModule.linkable.merchant,
  StockLocationModule.linkable.stockLocation
)
```

`marketlens-commerce/src/links/merchant-api-key.ts` :

```ts
import { defineLink } from "@medusajs/framework/utils"
import MerchantModule from "../modules/merchant"
import ApiKeyModule from "@medusajs/medusa/api-key"

export default defineLink(
  MerchantModule.linkable.merchant,
  ApiKeyModule.linkable.apiKey
)
```

- [ ] **Step 6 : Appliquer les migrations des liens**

```bash
cd marketlens-commerce && npx medusa db:migrate
```

Attendu : les tables de liens sont créées, `Migrations completed`.

- [ ] **Step 7 : Lancer le test pour vérifier qu'il passe**

```bash
cd marketlens-commerce && npm run test:integration:http
```

Attendu : 2 tests PASSÉS.

- [ ] **Step 8 : Commit**

```bash
git add marketlens-commerce/src marketlens-commerce/integration-tests
git commit -m "feat(commerce): workflow de provisionnement marchand avec compensation"
```

---

### Task 3 : Type d'acteur `merchant` et inscription

Medusa fournit déjà les routes génériques `/auth/merchant/emailpass/register` et `/auth/merchant/emailpass`. Il n'y a **aucun code d'authentification à écrire** : seulement à rattacher l'identité créée au marchand provisionné.

**Files:**
- Create: `marketlens-commerce/src/api/middlewares.ts`
- Create: `marketlens-commerce/src/api/merchant/register/route.ts`
- Test: `marketlens-commerce/integration-tests/http/merchant-auth.spec.ts`

**Interfaces:**
- Consumes: `createMerchantWorkflow` (tâche 2)
- Produces: `POST /merchant/register` acceptant `{ name, handle, phone, whatsapp_phone? }` et un en-tête `Authorization: Bearer <token d'inscription>`, renvoyant `{ merchant: { id, name, handle }, publishable_key }`. Après cet appel, l'identité d'authentification porte `app_metadata.merchant_id`.

- [ ] **Step 1 : Écrire le test qui échoue**

`marketlens-commerce/integration-tests/http/merchant-auth.spec.ts` :

```ts
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"

jest.setTimeout(60 * 1000)

medusaIntegrationTestRunner({
  testSuite: ({ api }) => {
    describe("Inscription et authentification d'un marchand", () => {
      it("inscrit un marchand et lui délivre un jeton exploitable", async () => {
        const inscription = await api.post("/auth/merchant/emailpass/register", {
          email: "fatou@marketlens.test",
          password: "motdepasse-de-test",
        })
        expect(inscription.status).toBe(200)
        const jetonInscription = inscription.data.token

        const creation = await api.post(
          "/merchant/register",
          { name: "Étal de Fatou", handle: "etal-de-fatou", phone: "22990000001" },
          { headers: { authorization: `Bearer ${jetonInscription}` } }
        )
        expect(creation.status).toBe(200)
        expect(creation.data.merchant.handle).toBe("etal-de-fatou")
        expect(creation.data.publishable_key).toMatch(/^pk_/)

        // Le jeton obtenu à la connexion doit désormais porter le marchand.
        const connexion = await api.post("/auth/merchant/emailpass", {
          email: "fatou@marketlens.test",
          password: "motdepasse-de-test",
        })
        expect(connexion.status).toBe(200)
        expect(connexion.data.token).toBeTruthy()
      })

      it("refuse l'inscription sans jeton d'authentification", async () => {
        const reponse = await api
          .post("/merchant/register", {
            name: "Sans jeton", handle: "sans-jeton", phone: "22990000099",
          })
          .catch((e) => e.response)

        expect(reponse.status).toBe(401)
      })
    })
  },
})
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

```bash
cd marketlens-commerce && npm run test:integration:http -- merchant-auth
```

Attendu : ÉCHEC — la route `/merchant/register` renvoie 404.

- [ ] **Step 3 : Déclarer les middlewares**

`marketlens-commerce/src/api/middlewares.ts` :

```ts
import { defineMiddlewares, authenticate } from "@medusajs/framework/http"

export default defineMiddlewares({
  routes: [
    {
      // L'inscription accepte une identité pas encore rattachée à un marchand.
      matcher: "/merchant/register",
      method: "POST",
      middlewares: [
        authenticate("merchant", ["bearer"], { allowUnregistered: true }),
      ],
    },
    {
      // Tout le reste exige une identité déjà rattachée.
      matcher: "/merchant/*",
      middlewares: [authenticate("merchant", ["session", "bearer"])],
    },
  ],
})
```

L'ordre compte : la règle spécifique de `/merchant/register` doit précéder la règle générale, sinon l'inscription exigerait une identité déjà rattachée — un marchand ne pourrait jamais s'inscrire.

- [ ] **Step 4 : Écrire la route d'inscription**

`marketlens-commerce/src/api/merchant/register/route.ts` :

```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { setAuthAppMetadataStep } from "@medusajs/medusa/core-flows"
import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import createMerchantWorkflow from "../../../workflows/create-merchant"

type CorpsInscription = {
  name: string
  handle: string
  phone: string
  whatsapp_phone?: string
}

const inscrireMarchandWorkflow = createWorkflow(
  "inscrire-marchand",
  (input: CorpsInscription & { auth_identity_id: string }) => {
    // `createMerchantWorkflow` n'accepte que les champs du marchand :
    // lui passer `auth_identity_id` en plus serait une erreur de typage.
    const donneesMarchand = transform(input, (i) => ({
      name: i.name,
      handle: i.handle,
      phone: i.phone,
      whatsapp_phone: i.whatsapp_phone,
    }))

    const provision = createMerchantWorkflow.runAsStep({ input: donneesMarchand })

    setAuthAppMetadataStep({
      authIdentityId: input.auth_identity_id,
      actorType: "merchant",
      value: provision.merchant_id,
    })

    return new WorkflowResponse(provision)
  }
)

export const POST = async (
  req: MedusaRequest<CorpsInscription>,
  res: MedusaResponse
) => {
  const { name, handle, phone, whatsapp_phone } = req.body

  if (!name || !handle || !phone) {
    return res.status(400).json({
      message: "Les champs name, handle et phone sont obligatoires",
    })
  }

  const { result } = await inscrireMarchandWorkflow(req.scope).run({
    input: {
      name,
      handle,
      phone,
      whatsapp_phone,
      auth_identity_id: req.auth_context.auth_identity_id,
    },
  })

  res.json({
    merchant: { id: result.merchant_id, name, handle },
    publishable_key: result.publishable_key,
  })
}
```

- [ ] **Step 5 : Lancer le test pour vérifier qu'il passe**

```bash
cd marketlens-commerce && npm run test:integration:http -- merchant-auth
```

Attendu : 2 tests PASSÉS.

- [ ] **Step 6 : Commit**

```bash
git add marketlens-commerce/src/api marketlens-commerce/integration-tests
git commit -m "feat(commerce): type d'acteur merchant et route d'inscription"
```

---

### Task 4 : Portée des requêtes et route `/merchant/me`

**Files:**
- Create: `marketlens-commerce/src/api/merchant/me/route.ts`
- Test: `marketlens-commerce/integration-tests/http/merchant-me.spec.ts`

**Interfaces:**
- Consumes: `POST /merchant/register` (tâche 3), `MERCHANT_MODULE` (tâche 1)
- Produces: `GET /merchant/me` renvoyant `{ merchant: { id, name, handle, phone, whatsapp_phone, currency_code, status } }` pour le marchand porté par le jeton, et 401 sans jeton valide.

- [ ] **Step 1 : Écrire le test qui échoue**

`marketlens-commerce/integration-tests/http/merchant-me.spec.ts` :

```ts
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"

jest.setTimeout(60 * 1000)

async function inscrireMarchand(api, email: string, handle: string, phone: string) {
  const inscription = await api.post("/auth/merchant/emailpass/register", {
    email, password: "motdepasse-de-test",
  })
  const creation = await api.post(
    "/merchant/register",
    { name: `Étal ${handle}`, handle, phone },
    { headers: { authorization: `Bearer ${inscription.data.token}` } }
  )
  const connexion = await api.post("/auth/merchant/emailpass", {
    email, password: "motdepasse-de-test",
  })
  return {
    jeton: connexion.data.token,
    merchantId: creation.data.merchant.id,
    publishableKey: creation.data.publishable_key,
  }
}

medusaIntegrationTestRunner({
  testSuite: ({ api }) => {
    describe("GET /merchant/me", () => {
      it("renvoie le marchand porté par le jeton", async () => {
        const fatou = await inscrireMarchand(api, "fatou@marketlens.test", "etal-fatou", "22990000001")

        const reponse = await api.get("/merchant/me", {
          headers: { authorization: `Bearer ${fatou.jeton}` },
        })

        expect(reponse.status).toBe(200)
        expect(reponse.data.merchant.id).toBe(fatou.merchantId)
        expect(reponse.data.merchant.handle).toBe("etal-fatou")
        expect(reponse.data.merchant.currency_code).toBe("xof")
      })

      it("refuse une requête sans jeton", async () => {
        const reponse = await api.get("/merchant/me").catch((e) => e.response)
        expect(reponse.status).toBe(401)
      })
    })
  },
})
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

```bash
cd marketlens-commerce && npm run test:integration:http -- merchant-me
```

Attendu : ÉCHEC — la route renvoie 404.

- [ ] **Step 3 : Écrire la route**

`marketlens-commerce/src/api/merchant/me/route.ts` :

```ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { MERCHANT_MODULE } from "../../../modules/merchant"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const merchantId = req.auth_context.actor_id

  if (!merchantId) {
    return res.status(401).json({ message: "Identité non rattachée à un marchand" })
  }

  const service: any = req.scope.resolve(MERCHANT_MODULE)
  const marchand = await service.retrieveMerchant(merchantId)

  res.json({ merchant: marchand })
}
```

`req.auth_context.actor_id` est renseigné par le middleware `authenticate` depuis `app_metadata.merchant_id` — la valeur posée par `setAuthAppMetadataStep` à la tâche 3. Aucune route ne lit un identifiant de marchand depuis le corps ou l'URL : il vient toujours du jeton.

- [ ] **Step 4 : Lancer le test pour vérifier qu'il passe**

```bash
cd marketlens-commerce && npm run test:integration:http -- merchant-me
```

Attendu : 2 tests PASSÉS.

- [ ] **Step 5 : Commit**

```bash
git add marketlens-commerce/src/api marketlens-commerce/integration-tests
git commit -m "feat(commerce): route /merchant/me portée par le jeton"
```

---

### Task 5 : Le test d'isolation multi-tenant

**S'il n'existe qu'un test à ne jamais laisser casser dans ce dépôt, c'est celui-là.** Il n'ajoute aucune fonctionnalité : il prouve que la sécurité tient.

**Files:**
- Test: `marketlens-commerce/integration-tests/http/merchant-isolation.spec.ts`

**Interfaces:**
- Consumes: `POST /merchant/register`, `GET /merchant/me` (tâches 3 et 4), `createProductsWorkflow` (Medusa)
- Produces: rien — tâche de vérification pure

- [ ] **Step 1 : Écrire le test d'isolation**

`marketlens-commerce/integration-tests/http/merchant-isolation.spec.ts` :

```ts
import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { createProductsWorkflow } from "@medusajs/medusa/core-flows"

jest.setTimeout(90 * 1000)

async function inscrireMarchand(api, email: string, handle: string, phone: string) {
  const inscription = await api.post("/auth/merchant/emailpass/register", {
    email, password: "motdepasse-de-test",
  })
  const creation = await api.post(
    "/merchant/register",
    { name: `Étal ${handle}`, handle, phone },
    { headers: { authorization: `Bearer ${inscription.data.token}` } }
  )
  const connexion = await api.post("/auth/merchant/emailpass", {
    email, password: "motdepasse-de-test",
  })
  return {
    jeton: connexion.data.token,
    merchantId: creation.data.merchant.id,
    publishableKey: creation.data.publishable_key,
  }
}

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Isolation entre marchands", () => {
      it("aucune donnée ne franchit la frontière entre deux marchands", async () => {
        const fatou = await inscrireMarchand(api, "fatou@marketlens.test", "etal-fatou", "22990000001")
        const kofi = await inscrireMarchand(api, "kofi@marketlens.test", "etal-kofi", "22990000002")

        expect(fatou.merchantId).not.toBe(kofi.merchantId)
        expect(fatou.publishableKey).not.toBe(kofi.publishableKey)

        // --- 1. Le jeton de Fatou ne donne accès qu'à Fatou ---
        const moiFatou = await api.get("/merchant/me", {
          headers: { authorization: `Bearer ${fatou.jeton}` },
        })
        expect(moiFatou.data.merchant.id).toBe(fatou.merchantId)
        expect(moiFatou.data.merchant.handle).toBe("etal-fatou")

        const moiKofi = await api.get("/merchant/me", {
          headers: { authorization: `Bearer ${kofi.jeton}` },
        })
        expect(moiKofi.data.merchant.id).toBe(kofi.merchantId)

        // --- 2. Un produit du canal de Fatou est invisible avec la clé de Kofi ---
        const canalFatou = await recupererCanal(getContainer(), fatou.merchantId)
        const canalKofi = await recupererCanal(getContainer(), kofi.merchantId)
        expect(canalFatou).not.toBe(canalKofi)

        const { result: produits } = await createProductsWorkflow(getContainer()).run({
          input: {
            products: [
              {
                title: "Tomates de Fatou",
                status: "published",
                options: [{ title: "Défaut", values: ["unique"] }],
                variants: [
                  { title: "unique", options: { "Défaut": "unique" }, manage_inventory: false },
                ],
                sales_channels: [{ id: canalFatou }],
              },
            ],
          },
        })
        expect(produits[0].id).toBeTruthy()

        const vuParFatou = await api.get("/store/products", {
          headers: { "x-publishable-api-key": fatou.publishableKey },
        })
        expect(vuParFatou.data.products.map((p) => p.title)).toContain("Tomates de Fatou")

        const vuParKofi = await api.get("/store/products", {
          headers: { "x-publishable-api-key": kofi.publishableKey },
        })
        expect(vuParKofi.data.products.map((p) => p.title)).not.toContain("Tomates de Fatou")

        // --- 3. Une requête sans clé publiable ne voit rien ---
        const sansCle = await api.get("/store/products").catch((e) => e.response)
        expect([400, 401]).toContain(sansCle.status)
      })
    })
  },
})
```

Ajouter cette assistante dans le **même fichier**, à côté d'`inscrireMarchand`, avant l'appel à `medusaIntegrationTestRunner`. Elle résout le sales channel lié au marchand : les liens créés à la tâche 2 sont interrogeables par le service de requête, ce qui vérifie au passage que ces liens existent réellement.

```ts
async function recupererCanal(container, merchantId: string): Promise<string> {
  const query = container.resolve("query")
  const { data } = await query.graph({
    entity: "merchant",
    fields: ["id", "sales_channel.*"],
    filters: { id: merchantId },
  })
  return data[0].sales_channel.id
}
```

- [ ] **Step 2 : Lancer le test**

```bash
cd marketlens-commerce && npm run test:integration:http -- merchant-isolation
```

Attendu : 1 test PASSÉ. **Si ce test échoue, ne poursuis pas — rapporte-le.** Un échec signifie que l'isolation ne tient pas, ce qui invalide tout le lot.

- [ ] **Step 3 : Lancer la totalité de la suite**

```bash
cd marketlens-commerce && npm run test:integration:modules && npm run test:integration:http
```

Attendu : 3 tests de module, 7 tests HTTP, tous passés.

- [ ] **Step 4 : Commit**

```bash
git add marketlens-commerce/integration-tests
git commit -m "test(commerce): prouve l'isolation des données entre marchands"
```

---

## Vérification finale du plan

- [ ] `npm run test:integration:modules` → 3 tests passés
- [ ] `npm run test:integration:http` → 7 tests passés
- [ ] Le test d'isolation passe
- [ ] `npx medusa develop` démarre et `/health` répond 200
- [ ] Deux marchands provisionnés ont bien deux sales channels, deux stock locations et deux clés publiables distincts
- [ ] Aucune colonne d'identifiant inter-modules sur l'entité `Merchant` — les rattachements sont des liens

## Ce que ce plan ne fait pas

Le back-office marchand (interface) et la vitrine client relèvent du plan 4. Le module `visual-catalog` et les workflows photo → produits relèvent du plan 3.

Ce plan ne construit **aucune interface** : il produit une API et la preuve que son cloisonnement tient. La preuve est le livrable.

Un point demeure ouvert et devra être tranché au plan 4 : l'admin Medusa natif reste accessible sur le port 9000 avec le compte opérateur. Tant qu'il n'est pas restreint par réseau ou désactivé en production, il constitue un accès total à toutes les données de tous les marchands. C'est acceptable en développement local, et impératif à traiter avant toute mise en ligne.
