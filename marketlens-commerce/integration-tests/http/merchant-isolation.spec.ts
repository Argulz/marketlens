import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import {
  createProductsWorkflow,
  createCollectionsWorkflow,
  createProductCategoriesWorkflow,
} from "@medusajs/medusa/core-flows"
import { MERCHANT_MODULE } from "../../src/modules/merchant"
import { servirVisionFactice } from "./helpers/vision-stub"

jest.setTimeout(120 * 1000)

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

type RessourcesMarchand = {
  canal: string
  emplacement: string
  cle: string
}

// Résout les trois ressources provisionnées pour un marchand via le service de
// requête. Les liens créés par le workflow de provisionnement (tâche 2) sont
// exposés par `query.graph` sous les champs singuliers `sales_channel`,
// `stock_location` et `api_key` (observé, pas supposé : les trois se résolvent
// en un seul appel). Interroger ces liens ici vérifie au passage qu'ils
// existent réellement — si l'un manquait ou pointait vers la mauvaise
// ressource, l'accès à `.id` lèverait ou renverrait une valeur fausse.
//
// La spec nomme trois mécanismes d'isolation (canal de vente, emplacement de
// stock, acteur d'authentification) ; ne récupérer que le canal ne prouvait
// rien sur l'emplacement, dont la distinction entre marchands était promise
// par la vérification finale du plan sans qu'aucun test ne la constate.
async function recupererRessources(
  container,
  merchantId: string
): Promise<RessourcesMarchand> {
  const query = container.resolve("query")
  const { data } = await query.graph({
    entity: "merchant",
    fields: ["id", "sales_channel.*", "stock_location.*", "api_key.*"],
    filters: { id: merchantId },
  })
  return {
    canal: data[0].sales_channel.id,
    emplacement: data[0].stock_location.id,
    cle: data[0].api_key.id,
  }
}

// Assertion la plus forte du fichier : la clé publiable d'un marchand est liée
// à *exactement un* canal de vente. Toutes les assertions de non-visibilité
// ci-dessous resteraient vertes si la clé d'un marchand était liée à un
// sur-ensemble de canaux contenant le sien ; celle-ci ne le resterait pas.
async function canauxDeLaCle(container, apiKeyId: string): Promise<string[]> {
  const query = container.resolve("query")
  const { data } = await query.graph({
    entity: "api_key",
    fields: ["id", "sales_channels.id"],
    filters: { id: apiKeyId },
  })
  return (data[0].sales_channels ?? []).map((c) => c.id)
}

async function creerProduit(container, titre: string, canal: string) {
  const { result } = await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: titre,
          status: "published",
          options: [{ title: "Défaut", values: ["unique"] }],
          variants: [
            { title: "unique", options: { "Défaut": "unique" }, manage_inventory: false },
          ],
          sales_channels: [{ id: canal }],
        },
      ],
    },
  })
  return result[0]
}

async function titresVus(api, publishableKey: string): Promise<string[]> {
  const reponse = await api.get("/store/products", {
    headers: { "x-publishable-api-key": publishableKey },
  })
  return reponse.data.products.map((p) => p.title)
}

// --- Helpers du volet « statut marchand » ---------------------------------
//
// La spec pose que `status` n'est pas décoratif : toute route marchand
// refuse un marchand non `active`, et une vitrine publiée par un marchand
// suspendu cesse d'être servie. Ces helpers montent le décor minimal pour
// le vérifier de bout en bout, par les vraies routes HTTP.

const ZONE_TOMATES = {
  label: "Tomates", x: 250, y: 400, width: 200, height: 150, category: "fruits_legumes",
}

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

/** Crée un brouillon par la vraie route multipart, avec son propre serveur
 *  de vision factice fermé dans un `finally`. */
async function analyserPhoto(api, jeton: string, titre: string) {
  const vision = await servirVisionFactice({
    detect: { products: [ZONE_TOMATES], count: 1 },
  })
  try {
    const reponse = await api.post("/merchant/catalogues", corpsPhoto(titre), {
      headers: { authorization: `Bearer ${jeton}` },
    })
    return {
      id: reponse.data.catalogue.id,
      handle: reponse.data.catalogue.handle,
      zones: reponse.data.zones,
    }
  } finally {
    await vision.fermer()
  }
}

function itemsPour(catalogue: { zones: any[] }) {
  return [
    {
      zone_id: catalogue.zones[0].id,
      label: "Tomates fraîches",
      price: "500",
      quantity: 2,
      colors: [],
      sizes: [],
    },
  ]
}

async function publierCatalogue(api, jeton: string, catalogue: { id: string; zones: any[] }) {
  const vision = await servirVisionFactice({ detect: { products: [], count: 0 } })
  try {
    return await api.post(
      `/merchant/catalogues/${catalogue.id}/publish`,
      { items: itemsPour(catalogue) },
      { headers: { authorization: `Bearer ${jeton}` } }
    )
  } finally {
    await vision.fermer()
  }
}

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Isolation entre marchands", () => {
      it("aucune donnée ne franchit la frontière entre deux marchands", async () => {
        const yaa = await inscrireMarchand(api, "yaa@marketlens.test", "etal-yaa", "22990000031")
        const kwame = await inscrireMarchand(api, "kwame@marketlens.test", "etal-kwame", "22990000032")

        expect(yaa.merchantId).not.toBe(kwame.merchantId)
        expect(yaa.publishableKey).not.toBe(kwame.publishableKey)

        // --- 1. Le jeton de Yaa ne donne accès qu'à Yaa ---
        const moiYaa = await api.get("/merchant/me", {
          headers: { authorization: `Bearer ${yaa.jeton}` },
        })
        expect(moiYaa.data.merchant.id).toBe(yaa.merchantId)
        expect(moiYaa.data.merchant.handle).toBe("etal-yaa")

        const moiKwame = await api.get("/merchant/me", {
          headers: { authorization: `Bearer ${kwame.jeton}` },
        })
        expect(moiKwame.data.merchant.id).toBe(kwame.merchantId)

        // --- 2. Les trois ressources provisionnées sont distinctes ---
        const resYaa = await recupererRessources(getContainer(), yaa.merchantId)
        const resKwame = await recupererRessources(getContainer(), kwame.merchantId)

        expect(resYaa.canal).not.toBe(resKwame.canal)
        expect(resYaa.emplacement).not.toBe(resKwame.emplacement)
        expect(resYaa.cle).not.toBe(resKwame.cle)

        // --- 3. Chaque clé publiable ne porte qu'un seul canal ---
        expect(await canauxDeLaCle(getContainer(), resYaa.cle)).toEqual([resYaa.canal])
        expect(await canauxDeLaCle(getContainer(), resKwame.cle)).toEqual([resKwame.canal])

        // --- 4. Les produits sont cloisonnés dans les deux sens ---
        // Un produit créé sur le seul canal de Yaa laisserait passer une
        // rupture asymétrique (clé de Yaa liée à un sur-ensemble de canaux).
        // On crée donc un produit de chaque côté et on assert les quatre
        // combinaisons.
        const produitYaa = await creerProduit(getContainer(), "Tomates de Yaa", resYaa.canal)
        const produitKwame = await creerProduit(getContainer(), "Ignames de Kwame", resKwame.canal)
        expect(produitYaa.id).toBeTruthy()
        expect(produitKwame.id).toBeTruthy()

        const vuParYaa = await titresVus(api, yaa.publishableKey)
        expect(vuParYaa).toContain("Tomates de Yaa")
        expect(vuParYaa).not.toContain("Ignames de Kwame")

        const vuParKwame = await titresVus(api, kwame.publishableKey)
        expect(vuParKwame).toContain("Ignames de Kwame")
        expect(vuParKwame).not.toContain("Tomates de Yaa")

        // --- 5. Une requête sans clé publiable ne voit rien ---
        // Le refus est déterministe : le framework répond 400 (clé absente),
        // pas 401.
        const sansCle = await api.get("/store/products").catch((e) => e.response)
        expect(sansCle.status).toBe(400)
      })

      it("LIMITE CONNUE : les collections et les catégories ne sont PAS cloisonnées par le canal de vente", async () => {
        // Ce test constate volontairement une fuite, il ne la célèbre pas.
        //
        // La spec affirmait que « la vitrine d'un marchand ne peut
        // structurellement pas retourner les produits d'un autre : le
        // filtrage est appliqué par le framework ». C'est vrai de
        // /store/products et /store/carts, qui sont portés par le canal de
        // vente. Ce ne l'est PAS de /store/collections ni de
        // /store/product-categories : ces ressources sont globales à
        // l'instance, la clé publiable ne les filtre pas.
        //
        // Aucune fuite vive aujourd'hui — rien dans ce socle ne crée de
        // collection ni de catégorie par marchand. Mais le plan 3 construit le
        // catalogue visuel, et grouper les produits d'un marchand par
        // collection ou catégorie est le premier réflexe : il produirait alors
        // une fuite de noms de regroupement d'un marchand à l'autre. Le
        // groupement par marchand doit passer par un filtrage applicatif
        // explicite, jamais par la seule clé publiable.
        //
        // Ce test verrouille la frontière dans les deux sens : si Medusa
        // portait un jour ces deux ressources sur le canal de vente, il
        // deviendrait rouge et signalerait qu'on peut relâcher la contrainte.
        const zeinab = await inscrireMarchand(api, "zeinab@marketlens.test", "etal-zeinab", "22990000041")
        const salif = await inscrireMarchand(api, "salif@marketlens.test", "etal-salif", "22990000042")

        expect(zeinab.publishableKey).not.toBe(salif.publishableKey)

        await createCollectionsWorkflow(getContainer()).run({
          input: { collections: [{ title: "Collection privée de Zeinab" }] },
        })
        await createProductCategoriesWorkflow(getContainer()).run({
          input: {
            product_categories: [
              { name: "Catégorie privée de Zeinab", is_active: true, is_internal: false },
            ],
          },
        })

        const collectionsVuesParSalif = await api.get("/store/collections", {
          headers: { "x-publishable-api-key": salif.publishableKey },
        })
        expect(collectionsVuesParSalif.data.collections.map((c) => c.title)).toContain(
          "Collection privée de Zeinab"
        )

        const categoriesVuesParSalif = await api.get("/store/product-categories", {
          headers: { "x-publishable-api-key": salif.publishableKey },
        })
        expect(
          categoriesVuesParSalif.data.product_categories.map((c) => c.name)
        ).toContain("Catégorie privée de Zeinab")
      })

      it("un marchand suspendu perd ses routes marchand, et sa vitrine cesse d'être servie", async () => {
        // `status` n'était lu que par GET /merchant/me : un marchand suspendu
        // pouvait encore téléverser des photos, créer de vrais produits dans
        // son canal, poser du stock, et sa vitrine publiée continuait d'être
        // servie. La suspension n'avait donc aucun effet observable là où
        // elle compte.
        const awa = await inscrireMarchand(api, "awa@marketlens.test", "etal-awa", "22990000051")
        const enTete = { authorization: `Bearer ${awa.jeton}` }

        // Deux catalogues créés TANT QUE le marchand est actif : l'un publié
        // (pour éprouver la vitrine), l'autre laissé en brouillon. Sans ce
        // second brouillon, un 403 sur la publication serait indiscernable du
        // 409 « déjà publié » que la route rend de toute façon.
        const publie = await analyserPhoto(api, awa.jeton, "Étal publié")
        const brouillon = await analyserPhoto(api, awa.jeton, "Étal brouillon")

        const publication = await publierCatalogue(api, awa.jeton, publie)
        expect(publication.status).toBe(200)

        const vitrineAvant = await api.get(`/store/catalogues/${publie.handle}`, {
          headers: { "x-publishable-api-key": awa.publishableKey },
        })
        expect(vitrineAvant.status).toBe(200)

        // --- La suspension entre en vigueur ---
        const merchantService: any = getContainer().resolve(MERCHANT_MODULE)
        await merchantService.updateMerchants({ id: awa.merchantId, status: "suspended" })

        const MESSAGE_INACTIF = "Compte marchand inactif (statut : suspended)"

        const liste = await api
          .get("/merchant/catalogues", { headers: enTete })
          .catch((e) => e.response)
        expect(liste.status).toBe(403)
        expect(liste.data.message).toBe(MESSAGE_INACTIF)

        // Aucun serveur de vision factice n'est ouvert ici : le refus doit
        // tomber AVANT tout appel au service de vision. S'il tombait après,
        // ce n'est pas un 403 qu'on lirait.
        const envoi = await api
          .post("/merchant/catalogues", corpsPhoto("Étal suspendu"), { headers: enTete })
          .catch((e) => e.response)
        expect(envoi.status).toBe(403)
        expect(envoi.data.message).toBe(MESSAGE_INACTIF)

        const tentativePublication = await api
          .post(
            `/merchant/catalogues/${brouillon.id}/publish`,
            { items: itemsPour(brouillon) },
            { headers: enTete }
          )
          .catch((e) => e.response)
        expect(tentativePublication.status).toBe(403)
        expect(tentativePublication.data.message).toBe(MESSAGE_INACTIF)

        // La correction des prix d'un catalogue DÉJÀ publié : c'est la seule
        // route marchand qui écrit sur des produits en vente, donc celle par
        // laquelle une suspension inopérante coûterait le plus cher. Rien ne
        // structure ce balayage — chaque route doit y être inscrite à la
        // main, sous peine de la régression du lot précédent.
        const tentativeCorrection = await api
          .patch(
            `/merchant/catalogues/${publie.id}/items`,
            { items: [{ zone_id: publie.zones[0].id, price: "600", quantity: 1 }] },
            { headers: enTete }
          )
          .catch((e) => e.response)
        expect(tentativeCorrection.status).toBe(403)
        expect(tentativeCorrection.data.message).toBe(MESSAGE_INACTIF)

        // Le retrait de la vitrine : le catalogue de `publie` est bien EN
        // LIGNE, donc un 409 « pas en ligne » serait indiscernable d'un refus
        // de statut mal placé. Le 403 doit tomber avant toute lecture du
        // catalogue.
        const tentativeRetrait = await api
          .post(`/merchant/catalogues/${publie.id}/unpublish`, {}, { headers: enTete })
          .catch((e) => e.response)
        expect(tentativeRetrait.status).toBe(403)
        expect(tentativeRetrait.data.message).toBe(MESSAGE_INACTIF)

        // La remise en ligne, éprouvée sur le BROUILLON pour la raison
        // symétrique : sur le catalogue publié, la route rendrait de toute
        // façon 409 « déjà en ligne ». Un marchand suspendu qui pourrait
        // republier remettrait en service la vitrine que la suspension vient
        // de couper.
        const tentativeRemise = await api
          .post(`/merchant/catalogues/${brouillon.id}/republish`, {}, { headers: enTete })
          .catch((e) => e.response)
        expect(tentativeRemise.status).toBe(403)
        expect(tentativeRemise.data.message).toBe(MESSAGE_INACTIF)

        // La vitrine rend 404 et non 403 : elle ne révèle ni l'existence du
        // catalogue ni la raison du refus. Le message est exactement celui
        // d'un catalogue inexistant.
        const vitrineApres = await api
          .get(`/store/catalogues/${publie.handle}`, {
            headers: { "x-publishable-api-key": awa.publishableKey },
          })
          .catch((e) => e.response)
        expect(vitrineApres.status).toBe(404)
        expect(vitrineApres.data.message).toBe("Catalogue introuvable")

        // La vitrine HTML (/c/<handle>) applique les mêmes règles que la route
        // JSON, mais par un chemin distinct : elle vit hors du namespace
        // /store, lit les données côté serveur et rend une page plutôt qu'un
        // objet. Sans ces assertions, la suspension pourrait être opposable au
        // JSON et inopérante sur la page que le public voit réellement.
        const pageApres = await api.get(`/c/${publie.handle}`).catch((e) => e.response)
        expect(pageApres.status).toBe(404)
        // Rien du marchand ni du catalogue ne doit transparaître : une page de
        // refus qui nommerait la boutique confirmerait son existence et sa
        // suspension à n'importe quel visiteur.
        expect(pageApres.data).not.toContain("etal-awa")
        expect(pageApres.data).not.toContain("Étal publié")
      })

      it("la vitrine HTML sert un catalogue publié et refuse un brouillon par la même page", async () => {
        const nafi = await inscrireMarchand(api, "nafi@marketlens.test", "etal-nafi", "22990000053")

        const publie = await analyserPhoto(api, nafi.jeton, "Étal de Nafi")
        const brouillon = await analyserPhoto(api, nafi.jeton, "Étal en attente")

        // Un brouillon est indiscernable d'un handle inexistant : même statut,
        // même page, aucun indice qu'il existe et attend une publication.
        const avant = await api.get(`/c/${publie.handle}`).catch((e) => e.response)
        const inconnu = await api.get("/c/nexiste-pas-du-tout").catch((e) => e.response)
        expect(avant.status).toBe(404)
        expect(inconnu.status).toBe(404)
        expect(avant.data).toBe(inconnu.data)

        expect((await publierCatalogue(api, nafi.jeton, publie)).status).toBe(200)

        const page = await api.get(`/c/${publie.handle}`)
        expect(page.status).toBe(200)
        expect(page.headers["content-type"]).toContain("text/html")
        expect(page.data).toContain("Étal etal-nafi")
        expect(page.data).toContain("Tomates")
        // L'image ANNOTÉE est celle que le marchand a validée ; l'image source
        // n'est jamais servie, pas plus ici que sur la route JSON.
        expect(page.data).toMatch(/<img[^>]+src="[^"]+"/)

        // Le brouillon du même marchand actif reste introuvable après la
        // publication de son voisin : c'est le statut du catalogue qui décide,
        // pas celui du marchand.
        const resteBrouillon = await api.get(`/c/${brouillon.handle}`).catch((e) => e.response)
        expect(resteBrouillon.status).toBe(404)
      })

      it("une identité dont le marchand a été supprimé reçoit 401, jamais une liste vide", async () => {
        // Un actor_id orphelin obtenait `200 []` sur la liste — indiscernable
        // d'un marchand actif sans catalogue — et le POST aurait créé un
        // catalogue rattaché à un marchand inexistant.
        const modou = await inscrireMarchand(api, "modou@marketlens.test", "etal-modou", "22990000052")
        const enTete = { authorization: `Bearer ${modou.jeton}` }

        const merchantService: any = getContainer().resolve(MERCHANT_MODULE)
        await merchantService.deleteMerchants(modou.merchantId)

        const liste = await api
          .get("/merchant/catalogues", { headers: enTete })
          .catch((e) => e.response)
        expect(liste.status).toBe(401)
        expect(liste.data.message).toBe("Identité non rattachée à un marchand")

        const envoi = await api
          .post("/merchant/catalogues", corpsPhoto("Étal fantôme"), { headers: enTete })
          .catch((e) => e.response)
        expect(envoi.status).toBe(401)
        expect(envoi.data.message).toBe("Identité non rattachée à un marchand")
      })
    })
  },
})
