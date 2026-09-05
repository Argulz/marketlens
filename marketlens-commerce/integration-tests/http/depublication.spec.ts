import { medusaIntegrationTestRunner } from "@medusajs/test-utils"
import { VISUAL_CATALOG_MODULE } from "../../src/modules/visual-catalog"
import { servirVisionFactice } from "./helpers/vision-stub"
import { CatalogueDeTest, publierUnCatalogue } from "./helpers/catalogue-publie"

jest.setTimeout(90 * 1000)

/** Identifiants des produits publiés du catalogue, zone par zone. C'est LA
 *  mesure du cycle : dépublier ne doit en retirer aucun, republier ne doit
 *  en ajouter aucun. Trié, parce que l'ordre des zones rendues par
 *  `query.graph` n'est garanti nulle part — un test qui dépendrait de cet
 *  ordre échouerait pour une raison sans rapport avec ce qu'il mesure. */
async function idsProduits(api: any, m: CatalogueDeTest): Promise<string[]> {
  const reponse = await api.get(`/merchant/catalogues/${m.catalogueId}`, {
    headers: { authorization: `Bearer ${m.jeton}` },
  })
  return reponse.data.catalogue.zones
    .filter((z: any) => z.product)
    .map((z: any) => z.product.id)
    .sort()
}

async function statutCatalogue(api: any, m: CatalogueDeTest): Promise<string> {
  const reponse = await api.get(`/merchant/catalogues/${m.catalogueId}`, {
    headers: { authorization: `Bearer ${m.jeton}` },
  })
  return reponse.data.catalogue.status
}

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("Cycle publier / dépublier / republier", () => {
      it("dépublier retire de la vitrine sans détruire les produits, et republier ne recrée rien", async () => {
        const m = await publierUnCatalogue(api, "etal-cycle", "22990000111")
        const enTete = { authorization: `Bearer ${m.jeton}` }

        const idsAvant = await idsProduits(api, m)
        expect(idsAvant.length).toBeGreaterThan(0)

        expect((await api.get(`/c/${m.handle}`)).status).toBe(200)

        const dep = await api.post(
          `/merchant/catalogues/${m.catalogueId}/unpublish`,
          {},
          { headers: enTete }
        )
        expect(dep.status).toBe(200)

        // La vitrine cesse de servir…
        const apres = await api.get(`/c/${m.handle}`).catch((e: any) => e.response)
        expect(apres.status).toBe(404)
        // …mais les produits, eux, sont intacts.
        expect(await idsProduits(api, m)).toEqual(idsAvant)
        expect(await statutCatalogue(api, m)).toBe("draft")

        // `annotateSeulement` ferme /detect en 500 : si la republication
        // repassait par la DÉTECTION, elle échouerait ici au lieu de rester
        // verte. Une simple absence de serveur ne le prouverait pas —
        // l'annotation échouerait elle aussi.
        const vision = await servirVisionFactice({ annotateSeulement: true })
        try {
          const rep = await api.post(
            `/merchant/catalogues/${m.catalogueId}/republish`,
            {},
            { headers: enTete }
          )
          expect(rep.status).toBe(200)
        } finally {
          await vision.fermer()
        }

        expect((await api.get(`/c/${m.handle}`)).status).toBe(200)
        // Aucun produit créé : c'est ce qui aurait explosé sur l'index
        // unique des handles produits, puisque le handle publié contient le
        // `zone_id`, qui est stable d'une publication à l'autre.
        expect(await idsProduits(api, m)).toEqual(idsAvant)
      })

      it("refuse de dépublier un brouillon, et de republier un catalogue déjà en ligne", async () => {
        const m = await publierUnCatalogue(api, "etal-cycle-2", "22990000112")
        const enTete = { authorization: `Bearer ${m.jeton}` }

        const dejaEnLigne = await api
          .post(`/merchant/catalogues/${m.catalogueId}/republish`, {}, { headers: enTete })
          .catch((e: any) => e.response)
        expect(dejaEnLigne.status).toBe(409)
        expect(dejaEnLigne.data.message).toMatch(/déjà/)

        const premiereDepublication = await api.post(
          `/merchant/catalogues/${m.catalogueId}/unpublish`,
          {},
          { headers: enTete }
        )
        expect(premiereDepublication.status).toBe(200)

        // Dépublier deux fois n'est pas une opération neutre à taire : la
        // seconde fois, il n'y a plus rien à retirer de la vitrine, et le
        // dire vaut mieux qu'un 200 qui laisserait croire à une action.
        const brouillon = await api
          .post(`/merchant/catalogues/${m.catalogueId}/unpublish`, {}, { headers: enTete })
          .catch((e: any) => e.response)
        expect(brouillon.status).toBe(409)
        expect(brouillon.data.message).toBe("Ce catalogue n'est pas en ligne")
      })

      it("refuse en français de republier quand la photo d'origine n'est plus disponible", async () => {
        const m = await publierUnCatalogue(api, "etal-cycle-3", "22990000113")
        const enTete = { authorization: `Bearer ${m.jeton}` }

        expect(
          (await api.post(`/merchant/catalogues/${m.catalogueId}/unpublish`, {}, { headers: enTete }))
            .status
        ).toBe(200)

        // Exactement l'état des catalogues créés avant la colonne
        // `source_image_id` : la photo d'origine n'est plus régénérable.
        const service: any = getContainer().resolve(VISUAL_CATALOG_MODULE)
        await service.updateVisualCatalogues({
          id: m.catalogueId,
          source_image_id: null,
        })

        const vision = await servirVisionFactice({ annotateSeulement: true })
        let refus: any
        try {
          refus = await api
            .post(`/merchant/catalogues/${m.catalogueId}/republish`, {}, { headers: enTete })
            .catch((e: any) => e.response)
        } finally {
          await vision.fermer()
        }

        // 409 et non 5xx : ce n'est pas une panne amont, c'est un état du
        // catalogue. Et surtout pas un 200 — remettre en ligne sans image à
        // jour servirait une vitrine qui ment sur les prix.
        expect(refus.status).toBe(409)
        expect(refus.data.message).toMatch(/photo d'origine/)
        // Aucun détail technique (chemin de fichier, nom d'erreur) ne fuit.
        expect(refus.data.message).not.toMatch(/Error|source_image_id|getAsBuffer/)

        // Le catalogue RESTE en brouillon, et la vitrine muette.
        expect(await statutCatalogue(api, m)).toBe("draft")
        const vitrine = await api.get(`/c/${m.handle}`).catch((e: any) => e.response)
        expect(vitrine.status).toBe(404)
      })
    })
  },
})
