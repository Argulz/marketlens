import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import analyzeCataloguePhotoWorkflow from "../../../workflows/analyze-catalogue-photo"
import { cataloguesDuMarchand, etiquetteJournal, marchandActifOuRefus } from "./scope"
import { TAILLE_MAX_IMAGE_MO } from "../../../lib/limites-image"
import {
  NOM_VISION_INDISPONIBLE,
  NOM_VISION_REFUSE,
} from "../../../lib/vision-client"

// Refus du service de vision (4xx) : la photo est en cause, pas le serveur.
// Le message doit dire au marchand quoi faire — et nommer la limite, parce
// que le cas de loin le plus fréquent est une photo trop lourde.
const MESSAGE_PHOTO_REFUSEE =
  `Cette photo n'a pas pu être analysée. Vérifiez qu'il s'agit bien d'une image (JPEG ou PNG) de moins de ${TAILLE_MAX_IMAGE_MO} Mo, puis réessayez.`

// Panne amont : le marchand n'y peut rien, et la supervision doit voir un
// 5xx. Le détail technique reste dans les journaux du serveur.
const MESSAGE_VISION_INDISPONIBLE =
  "L'analyse d'image est momentanément indisponible. Réessayez dans quelques minutes."

const MESSAGE_ECHEC_GENERIQUE =
  "L'analyse de cette photo a échoué. Réessayez plus tard."

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

  // Posé par `televerserImage` (src/api/middlewares.ts), en mémoire et sous
  // plafond de taille.
  const fichier = (req as any).files?.[0]
  if (!fichier) {
    return res.status(400).json({ message: "Une image est obligatoire" })
  }

  const titre = (req.body as any)?.title
  if (typeof titre !== "string" || !titre.trim()) {
    return res.status(400).json({ message: "Le champ title est obligatoire" })
  }

  try {
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

    return res.json({
      catalogue: { id: result.catalogue_id, handle: result.handle, status: "draft" },
      zones: result.zones,
    })
  } catch (e: any) {
    // Comme sur la route de publication : le rejet d'un `.run()` de workflow
    // n'est pas l'instance d'erreur d'origine (l'orchestrateur la remplace
    // par une copie en objet simple), donc `instanceof` est inutilisable et
    // seul `e.name` permet de reconnaître l'erreur — d'où les noms explicites
    // posés sur `VisionRefuse` / `VisionIndisponible`.
    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

    if (e?.name === NOM_VISION_REFUSE) {
      // 400 et non 500 : pour un marchand qui photographie son étal avec un
      // téléphone récent, une photo de 8 à 15 Mo est le cas NOMINAL. Le
      // framework rendait auparavant un 500 portant « Le service de vision a
      // refusé la requête (413) » — un texte technique, en partie anglais,
      // sur un cas d'usage courant.
      logger.warn(
        `POST /merchant/catalogues : photo refusée par le service de vision — ${e?.message}`
      )
      return res.status(400).json({ message: MESSAGE_PHOTO_REFUSEE })
    }

    if (e?.name === NOM_VISION_INDISPONIBLE) {
      // 503 : une panne amont doit rester visible en supervision comme un
      // 5xx. La compter en 400 la ferait passer pour une faute du marchand.
      logger.error(
        `POST /merchant/catalogues : service de vision indisponible — ${e?.message}`
      )
      return res.status(503).json({ message: MESSAGE_VISION_INDISPONIBLE })
    }

    logger.error(
      `POST /merchant/catalogues : échec inattendu — ${e?.message}`
    )
    return res.status(500).json({ message: MESSAGE_ECHEC_GENERIQUE })
  }
}
