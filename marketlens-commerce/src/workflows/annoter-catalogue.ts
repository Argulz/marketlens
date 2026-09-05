import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
  transform,
} from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { uploadFilesWorkflow } from "@medusajs/medusa/core-flows"
import { ProduitAnnote, annoterImage } from "../lib/vision-client"
import { VISUAL_CATALOG_MODULE } from "../modules/visual-catalog"
import VisualCatalogModuleService from "../modules/visual-catalog/service"

/**
 * Nom porté par `ErreurImageSourceIndisponible`, et testé par les routes.
 *
 * Pourquoi une constante plutôt qu'`instanceof` : le rejet d'un `.run()` de
 * workflow n'est jamais l'instance d'origine — l'orchestrateur la remplace
 * par une COPIE en objet simple (`{ message, name, stack }` plus les
 * propriétés propres ; voir workflows/steps/erreur-validation-publication.ts
 * pour la démonstration détaillée). Seul `.name` survit à cette
 * sérialisation, et il ne survit que parce qu'il est posé EXPLICITEMENT
 * ci-dessous : `class X extends Error {}` sans `this.name` laisse
 * `Error.prototype.name`, c'est-à-dire « Error ».
 */
export const NOM_ERREUR_IMAGE_SOURCE_INDISPONIBLE = "ErreurImageSourceIndisponible"

/** La photo d'origine du catalogue est DÉFINITIVEMENT perdue : soit le
 *  catalogue date d'avant la colonne `source_image_id` (28 catalogues du
 *  corpus, démonstrations), soit le fichier a été effacé du stockage. Ce
 *  n'est ni une faute de la commerçante ni une panne du service de vision :
 *  c'est un état, que chaque appelant traduit à sa façon.
 *
 *  Ce que cette erreur ne dit PAS : « le stockage n'a pas répondu ». Une
 *  panne transitoire remonte telle quelle depuis `lireImageSourceStep` pour
 *  ressortir en 5xx — la confondre avec cet état-ci enverrait la commerçante
 *  reprendre une photo qu'elle possède déjà. */
export class ErreurImageSourceIndisponible extends Error {
  constructor(message: string) {
    super(message)
    this.name = NOM_ERREUR_IMAGE_SOURCE_INDISPONIBLE
  }
}

export const MESSAGE_IMAGE_SOURCE_INDISPONIBLE =
  "La photo d'origine de ce catalogue n'est plus disponible."

export type AnnoterCatalogueInput = {
  catalogue_id: string
  source_image_id: string | null
  produits: ProduitAnnote[]
}

export type AnnoterCatalogueOutput = {
  annotated_image_url: string
}

/**
 * Relit la photo d'origine depuis le module File. Lecture pure : rien à
 * compenser.
 *
 * C'est CE step qui rend l'annotation réutilisable. L'ancienne étape
 * recevait le contenu de l'image en mémoire — ce que seule la publication
 * possède, puisqu'elle vient de le recevoir en multipart. La republication
 * et la correction de prix, elles, n'ont que le catalogue : elles doivent
 * pouvoir relire la source depuis le stockage.
 */
const lireImageSourceStep = createStep(
  "lire-image-source",
  async (input: { source_image_id: string | null }, { container }) => {
    if (!input.source_image_id) {
      throw new ErreurImageSourceIndisponible(MESSAGE_IMAGE_SOURCE_INDISPONIBLE)
    }
    const fichiers: any = container.resolve(Modules.FILE)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    let octets: Buffer
    try {
      octets = await fichiers.getAsBuffer(input.source_image_id)
    } catch (e) {
      // TOUTE erreur de lecture n'est PAS un état du catalogue. Aplatir les
      // deux en `ErreurImageSourceIndisponible` faisait sortir une panne de
      // stockage en 409 « reprenez une photo de votre étal » : un 4xx qui
      // accuse la saisie d'une défaillance amont, et un conseil qui envoie
      // la commerçante refaire un travail parfaitement inutile alors que sa
      // photo est intacte.
      //
      // `ENOENT` — le fichier n'existe plus — est le seul défaut PERMANENT
      // que le stockage local sait nommer : aucune reprise ne le ramènera,
      // et c'est bien un état du catalogue. Tout le reste (volume démonté,
      // disque saturé, seau distant injoignable, délai) est TRANSITOIRE et
      // remonte tel quel, pour ressortir en 5xx chez l'appelant.
      //
      // Le doute penche du côté transitoire : classer à tort un défaut
      // permanent en panne ne coûte qu'un 500 (« réessayez »), tandis que
      // l'inverse accuse la commerçante. Un autre fournisseur de stockage
      // (S3 et son `NoSuchKey`) devra ajouter ici SON code permanent —
      // jamais élargir la règle à « toute erreur ».
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        // Le détail technique (chemin, code errno du fournisseur) reste dans
        // les journaux du serveur ; l'appelant ne reçoit que l'état.
        logger.warn(
          `lire-image-source : fichier « ${input.source_image_id} » introuvable — ${(e as Error)?.message}`
        )
        throw new ErreurImageSourceIndisponible(MESSAGE_IMAGE_SOURCE_INDISPONIBLE)
      }
      // `error` et non `warn` : une photo effacée est un état, une panne de
      // stockage est un incident d'exploitation.
      logger.error(
        `lire-image-source : le stockage n'a pas répondu pour « ${input.source_image_id} » — ${(e as Error)?.message}`
      )
      throw e
    }
    // Même convention que le reste du chantier : un contenu binaire voyage
    // en chaîne "binary" entre les étapes, jamais en UTF-8 (qui
    // corromprait tout octet > 127).
    return new StepResponse(octets.toString("binary"))
  }
)

/** Lecture pure côté vision : rien à compenser. Le fichier annoté est
 *  déposé par l'étape suivante, qui porte sa propre compensation. */
const annoterStep = createStep(
  "annoter",
  async (input: { contenu: string; produits: ProduitAnnote[] }) => {
    const octets = await annoterImage(
      Buffer.from(input.contenu, "binary"),
      "annotee.jpg",
      input.produits
    )
    return new StepResponse(octets.toString("binary"))
  }
)

type UrlPrecedente = { catalogue_id: string; url: string | null }

const enregistrerUrlStep = createStep(
  "enregistrer-url-annotee",
  async (input: { catalogue_id: string; url: string }, { container }) => {
    const service = container.resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
    const avant = await service.retrieveVisualCatalogue(input.catalogue_id)
    await service.updateVisualCatalogues({
      id: input.catalogue_id,
      annotated_image_url: input.url,
    })
    // La compensation reçoit l'identifiant EN PLUS de l'URL précédente :
    // sans lui, elle ne saurait pas quelle ligne remettre en état.
    const precedente: UrlPrecedente = {
      catalogue_id: input.catalogue_id,
      url: avant.annotated_image_url,
    }
    return new StepResponse({ url: input.url }, precedente)
  },
  async (urlPrecedente: UrlPrecedente | undefined, { container }) => {
    // `undefined` signifie que l'étape n'a jamais réussi : il n'y a rien à
    // défaire. Une valeur `null` sur `.url` est en revanche une vraie
    // valeur d'avant (catalogue jamais annoté) et doit être restaurée telle
    // quelle — la confondre avec « rien à faire » laisserait l'URL d'une
    // annotation compensée en base.
    if (urlPrecedente === undefined) return
    const service = container.resolve<VisualCatalogModuleService>(VISUAL_CATALOG_MODULE)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    try {
      await service.updateVisualCatalogues({
        id: urlPrecedente.catalogue_id,
        annotated_image_url: urlPrecedente.url,
      })
    } catch (e: any) {
      // Le nettoyage ne doit jamais écraser l'erreur d'origine : elle seule
      // explique pourquoi on compense.
      logger.error(`Compensation de l'URL annotée impossible : ${e?.message}`)
    }
  }
)

/**
 * Régénère l'image annotée d'un catalogue à partir de SA photo d'origine,
 * relue depuis le stockage, et enregistre la nouvelle URL sur le catalogue.
 *
 * Trois chemins l'appellent : la publication (publish-catalogue.ts), la
 * republication et la correction de prix. Aucun ne repasse par la
 * DÉTECTION : les zones sont déjà connues, seul le dessin change.
 */
export const annoterCatalogueWorkflow = createWorkflow(
  "annoter-catalogue",
  (input: AnnoterCatalogueInput) => {
    const contenu = lireImageSourceStep({ source_image_id: input.source_image_id })
    const octets = annoterStep({ contenu, produits: input.produits })

    const fichiers = uploadFilesWorkflow.runAsStep({
      input: {
        files: [
          transform({ octets }, (d) => ({
            filename: "catalogue-annote.jpg",
            mimeType: "image/jpeg",
            content: d.octets,
            // Image de vitrine : destinée à être affichée côté storefront.
            access: "public" as const,
          })),
        ],
      },
    })

    const url = transform({ fichiers }, (d) => d.fichiers[0].url)
    enregistrerUrlStep({ catalogue_id: input.catalogue_id, url })

    return new WorkflowResponse(
      transform({ url }, (d): AnnoterCatalogueOutput => ({ annotated_image_url: d.url }))
    )
  }
)

export default annoterCatalogueWorkflow
