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
