import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import analyzeCataloguePhotoWorkflow from "../../../workflows/analyze-catalogue-photo"
import { cataloguesDuMarchand, etiquetteJournal, marchandActifOuRefus } from "./scope"

export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  // En TÊTE, avant toute lecture : un marchand supprimé recevait sinon
  // `200 []` (indiscernable d'un marchand actif sans catalogue) et un
  // marchand suspendu voyait encore ses catalogues.
  const controle = await marchandActifOuRefus(
    req.scope,
    req.auth_context.actor_id,
    etiquetteJournal(req, "GET /merchant/catalogues")
  )
  if (!controle.autorise) {
    return res.status(controle.statut).json({ message: controle.message })
  }

  const catalogues = await cataloguesDuMarchand(req.scope, req.auth_context.actor_id)
  res.json({
    catalogues: catalogues.map((c) => ({
      id: c.id,
      handle: c.handle,
      title: c.title,
      status: c.status,
    })),
  })
}

export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
  // En TÊTE, avant même de regarder le fichier : un marchand suspendu ne doit
  // pas faire travailler le service de vision, et un actor_id orphelin ne doit
  // pas créer un catalogue rattaché à un marchand inexistant.
  const controle = await marchandActifOuRefus(
    req.scope,
    req.auth_context.actor_id,
    etiquetteJournal(req, "POST /merchant/catalogues")
  )
  if (!controle.autorise) {
    return res.status(controle.statut).json({ message: controle.message })
  }

  // Posé par `upload.array("image")` (src/api/middlewares.ts), en mémoire.
  const fichier = (req as any).files?.[0]
  if (!fichier) {
    return res.status(400).json({ message: "Une image est obligatoire" })
  }

  const titre = (req.body as any)?.title
  if (typeof titre !== "string" || !titre.trim()) {
    return res.status(400).json({ message: "Le champ title est obligatoire" })
  }

  const { result } = await analyzeCataloguePhotoWorkflow(req.scope).run({
    input: {
      merchant_id: req.auth_context.actor_id,
      filename: fichier.originalname,
      // Même convention que le reste du chantier : un contenu binaire est
      // porté en chaîne "binary", jamais en UTF-8 (qui corromprait tout
      // octet > 127).
      content: fichier.buffer.toString("binary"),
      title: titre,
    },
  })

  res.json({
    catalogue: { id: result.catalogue_id, handle: result.handle, status: "draft" },
    zones: result.zones,
  })
}
