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
              access: "public",
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
