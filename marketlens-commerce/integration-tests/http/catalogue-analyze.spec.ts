import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import analyzeCataloguePhotoWorkflow from "../../src/workflows/analyze-catalogue-photo"
import { VISUAL_CATALOG_MODULE } from "../../src/modules/visual-catalog"
import VisualCatalogModuleService from "../../src/modules/visual-catalog/service"
import createMerchantWorkflow from "../../src/workflows/create-merchant"
import { servirVisionFactice } from "./helpers/vision-stub"

jest.setTimeout(90 * 1000)

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    describe("analyzeCataloguePhoto", () => {
      it("crée un brouillon avec ses zones persistées, sans créer aucun produit", async () => {
        const vision = await servirVisionFactice({
          detect: {
            products: [
              { label: "Tomates", x: 250, y: 400, width: 200, height: 150, category: "fruits_legumes" },
              { label: "Ignames", x: 700, y: 500, width: 250, height: 300, category: "cereales" },
            ],
            count: 2,
          },
        })

        try {
          const { result: m } = await createMerchantWorkflow(getContainer()).run({
            input: { name: "Étal Analyse", handle: "etal-analyse", phone: "22990008001" },
          })

          // Référence AVANT exécution du workflow. On compare un delta plutôt
          // qu'un compte absolu à zéro : la base de test est partagée entre
          // tous les fichiers de la suite (mêmes scripts `--runInBand`, même
          // `dbName`), et un autre fichier peut avoir laissé des produits
          // derrière lui avant que ce fichier ne prenne son propre instantané
          // de restauration. Un compte absolu à zéro serait donc soit
          // accidentellement vrai (si personne d'autre n'a encore créé de
          // produit), soit accidentellement faux (pollué par un autre
          // fichier) — dans les deux cas, il ne prouverait rien sur CE
          // workflow. Le delta, lui, reste correct dans tous les cas : si le
          // workflow créait un produit, ce compte augmenterait, peu importe
          // sa valeur de départ.
          const query = getContainer().resolve(ContainerRegistrationKeys.QUERY)
          const { data: produitsAvant } = await query.graph({ entity: "product", fields: ["id"] })

          const { result } = await analyzeCataloguePhotoWorkflow(getContainer()).run({
            input: {
              merchant_id: m.merchant_id,
              filename: "etal.jpg",
              content: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("binary"),
              title: "Étal du matin",
            },
          })

          expect(result.catalogue_id).toBeTruthy()
          expect(result.handle).toBeTruthy()
          expect(result.zones).toHaveLength(2)
          // La sortie porte les zones telles que persistées : chacune a un
          // identifiant de base. Sans lui, la tâche 6 ne pourrait désigner
          // aucune zone à publier.
          for (const zone of result.zones) {
            expect(zone.id).toBeTruthy()
          }

          const service = getContainer().resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
          const cat = await service.retrieveVisualCatalogue(result.catalogue_id)
          expect(cat.status).toBe("draft")
          expect(cat.source_image_url).toBeTruthy()
          expect(cat.annotated_image_url).toBeNull()

          const zones = await service.listCatalogueZones({ catalogue_id: result.catalogue_id })
          expect(zones).toHaveLength(2)
          // Les zones renvoyées par le workflow doivent correspondre aux
          // zones réellement persistées (mêmes identifiants).
          expect(new Set(zones.map((z) => z.id))).toEqual(new Set(result.zones.map((z) => z.id)))

          // Le cœur du test : le workflow n'a créé aucun produit.
          const { data: produitsApres } = await query.graph({ entity: "product", fields: ["id"] })
          expect(produitsApres).toHaveLength(produitsAvant.length)
        } finally {
          await vision.fermer()
        }
      })

      it("arrondit à l'entier les coordonnées fractionnaires détectées avant de les persister", async () => {
        // `model.number()` produit une colonne SQL `integer`. Gemini (via le
        // service Python) produit déjà des coordonnées entières, mais rien
        // ne garantit côté TypeScript qu'un flottant ne puisse pas
        // s'introduire : `ZoneDetectee` type ses coordonnées en `number`.
        // Sans arrondi explicite à la persistance, le premier centroïde
        // fractionnaire produirait un rejet Postgres ou une coercition
        // silencieuse.
        const vision = await servirVisionFactice({
          detect: {
            products: [
              { label: "Piments", x: 250.6, y: 400.4, width: 200.5, height: 150.49, category: "fruits_legumes" },
            ],
            count: 1,
          },
        })

        try {
          const { result: m } = await createMerchantWorkflow(getContainer()).run({
            input: { name: "Étal Fractions", handle: "etal-fractions", phone: "22990008002" },
          })

          const { result } = await analyzeCataloguePhotoWorkflow(getContainer()).run({
            input: {
              merchant_id: m.merchant_id,
              filename: "etal.jpg",
              content: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("binary"),
              title: "Étal fractionné",
            },
          })

          expect(result.zones).toHaveLength(1)
          const zone = result.zones[0]
          expect(zone.x).toBe(251)
          expect(zone.y).toBe(400)
          expect(zone.width).toBe(201)
          expect(zone.height).toBe(150)
          expect(Number.isInteger(zone.x)).toBe(true)
          expect(Number.isInteger(zone.y)).toBe(true)
          expect(Number.isInteger(zone.width)).toBe(true)
          expect(Number.isInteger(zone.height)).toBe(true)

          const service = getContainer().resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
          const relue = await service.retrieveCatalogueZone(zone.id)
          expect([relue.x, relue.y, relue.width, relue.height]).toEqual([251, 400, 201, 150])
        } finally {
          await vision.fermer()
        }
      })

      it("annule le catalogue et ses zones si le rattachement au marchand échoue", async () => {
        // Contrairement au test de collision de handle du marchand, cet échec
        // est déclenché APRÈS que le catalogue et ses zones ont réellement
        // été persistés (le workflow est strictement séquentiel :
        // `createCatalogueDraftStep` s'exécute avant `createRemoteLinkStep`).
        // Sans compensation — et sans que celle-ci efface d'abord les zones,
        // qui portent une clé étrangère vers le catalogue sans cascade de
        // suppression en base — le catalogue et ses zones resteraient
        // orphelins, ou la compensation elle-même échouerait sur une
        // violation de contrainte.
        const titreDistinctif = "Titre Compensation Unique 8f3a"
        const labelDistinctif = "Zone Compensation Unique 8f3a"

        const vision = await servirVisionFactice({
          detect: {
            products: [
              { label: labelDistinctif, x: 100, y: 100, width: 50, height: 50, category: "fruits_legumes" },
            ],
            count: 1,
          },
        })

        try {
          const { result: m } = await createMerchantWorkflow(getContainer()).run({
            input: { name: "Étal Rollback", handle: "etal-rollback-catalogue", phone: "22990008003" },
          })

          const linkService: any = getContainer().resolve(ContainerRegistrationKeys.LINK)
          const spy = jest
            .spyOn(linkService, "create")
            .mockRejectedValueOnce(new Error("échec simulé du rattachement marchand"))

          let aEchoue = false
          try {
            await analyzeCataloguePhotoWorkflow(getContainer()).run({
              input: {
                merchant_id: m.merchant_id,
                filename: "etal.jpg",
                content: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("binary"),
                title: titreDistinctif,
              },
            })
          } catch (e) {
            aEchoue = true
          } finally {
            spy.mockRestore()
          }
          expect(aEchoue).toBe(true)

          const service = getContainer().resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
          const cataloguesOrphelins = await service.listVisualCatalogues({ title: titreDistinctif })
          expect(cataloguesOrphelins).toHaveLength(0)

          const zonesOrphelines = await service.listCatalogueZones({ detected_label: labelDistinctif })
          expect(zonesOrphelines).toHaveLength(0)
        } finally {
          await vision.fermer()
        }
      })

      it("n'orpheline aucun catalogue si l'écriture groupée des zones échoue", async () => {
        // Complète le fix du reviewer (un appel groupé plutôt qu'une boucle
        // d'appels un par un). Même avec un appel unique, la création du
        // catalogue et celle des zones restent deux appels distincts au
        // service, chacun dans sa propre transaction. Si ce second appel
        // échoue APRÈS que le premier a réussi, le step
        // `create-catalogue-draft` lui-même n'a jamais retourné de
        // `StepResponse` : l'orchestrateur n'invoque donc jamais sa
        // compensation (elle a besoin des données que seul un retour réussi
        // fournit). Sans le filet ajouté dans le step (`try/catch` autour de
        // l'écriture des zones, qui efface le catalogue avant de repropager
        // l'erreur), le catalogue resterait en base, orphelin et sans aucune
        // zone — en contradiction avec « une analyse ratée ne coûte rien et
        // s'annule sans trace ».
        const titreDistinctif = "Titre Echec Zones Unique 2c91"

        const vision = await servirVisionFactice({
          detect: {
            products: [
              { label: "Bananes", x: 100, y: 100, width: 50, height: 50, category: "fruits_legumes" },
            ],
            count: 1,
          },
        })

        try {
          const { result: m } = await createMerchantWorkflow(getContainer()).run({
            input: { name: "Étal Echec Zones", handle: "etal-echec-zones", phone: "22990008004" },
          })

          const service = getContainer().resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
          const spy = jest
            .spyOn(service, "createCatalogueZones")
            .mockRejectedValueOnce(new Error("échec simulé de l'écriture groupée des zones"))

          let aEchoue = false
          try {
            await analyzeCataloguePhotoWorkflow(getContainer()).run({
              input: {
                merchant_id: m.merchant_id,
                filename: "etal.jpg",
                content: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("binary"),
                title: titreDistinctif,
              },
            })
          } catch (e) {
            aEchoue = true
          } finally {
            spy.mockRestore()
          }
          expect(aEchoue).toBe(true)

          // Le cœur du test : aucun catalogue orphelin — le filet du step a
          // effacé le catalogue déjà créé avant de repropager l'échec.
          const cataloguesOrphelins = await service.listVisualCatalogues({ title: titreDistinctif })
          expect(cataloguesOrphelins).toHaveLength(0)
        } finally {
          await vision.fermer()
        }
      })
    })
  },
})
