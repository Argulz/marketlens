import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export type CatalogueDuMarchand = {
  id: string
  handle: string
  title: string
  status: string
  source_image_url: string
  annotated_image_url: string | null
}

/**
 * Rend les catalogues du marchand porté par le jeton, et rien d'autre.
 * `merchantId` vient toujours de `req.auth_context.actor_id`, jamais du
 * corps ni de l'URL : c'est ce qui rend le cloisonnement structurel. Cet
 * assistant est le SEUL endroit qui décide qui voit quoi — les trois routes
 * marchand de ce module l'appellent plutôt que de refaire ce filtrage
 * chacune à sa façon.
 */
export async function cataloguesDuMarchand(
  container: MedusaContainer,
  merchantId: string
): Promise<CatalogueDuMarchand[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "merchant",
    fields: ["id", "visual_catalogues.*"],
    filters: { id: merchantId },
  })
  const marchand = data[0] as unknown as
    | { id: string; visual_catalogues: CatalogueDuMarchand[] }
    | undefined
  return marchand?.visual_catalogues ?? []
}

/** `null` si le catalogue n'existe pas OU n'appartient pas à ce marchand :
 *  les deux cas doivent être indiscernables pour l'appelant — un 403 sur un
 *  catalogue d'autrui confirmerait son existence à qui ne devrait pas la
 *  connaître. */
export async function catalogueDuMarchand(
  container: MedusaContainer,
  merchantId: string,
  catalogueId: string
): Promise<CatalogueDuMarchand | null> {
  const catalogues = await cataloguesDuMarchand(container, merchantId)
  return catalogues.find((c) => c.id === catalogueId) ?? null
}
