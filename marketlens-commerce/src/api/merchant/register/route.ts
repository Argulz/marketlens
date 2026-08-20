import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { setAuthAppMetadataStep } from "@medusajs/medusa/core-flows"
import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { z } from "zod"
import createMerchantWorkflow from "../../../workflows/create-merchant"
import { MERCHANT_MODULE } from "../../../modules/merchant"
import MerchantModuleService from "../../../modules/merchant/service"
import { MOTIF_HANDLE, LONGUEUR_MAX_HANDLE } from "../../../modules/merchant/handle"

// `handle` est destiné à devenir un segment d'URL publique (`/c/[handle]` au
// plan 3). Deux conséquences portées par ce motif :
//   - il ne doit contenir que ce qui traverse une URL sans encodage ni
//     interprétation : un `handle` comme `../admin` était accepté et persisté
//     tel quel avant ce contrôle ;
//   - il est normalisé en minuscules AVANT persistance, pas seulement validé.
//     L'index unique de Postgres est sensible à la casse : sans
//     normalisation, `etal-fatou` et `ETAL-FATOU` sont deux locataires
//     distincts qui se disputeraient la même URL de catalogue dès que le
//     routage minusculiserait le segment.
// Le motif et la borne de longueur viennent de ../../../modules/merchant/handle.ts,
// partagée avec createMerchantRecordStep : cette route est le premier filtre
// (400 propre), l'étape est le filet pour tout appel direct au workflow — les
// deux doivent appliquer exactement la même règle, jamais deux copies qui
// peuvent diverger.

const chaineObligatoire = (champ: string, max: number) =>
  z
    .string({
      error: `Le champ ${champ} est obligatoire et doit être une chaîne de caractères`,
    })
    .trim()
    .min(1, `Le champ ${champ} est obligatoire`)
    .max(max, `Le champ ${champ} ne doit pas dépasser ${max} caractères`)

const schemaInscription = z.object({
  name: chaineObligatoire("name", 120),
  handle: z
    .string({
      error: "Le champ handle est obligatoire et doit être une chaîne de caractères",
    })
    .max(
      LONGUEUR_MAX_HANDLE,
      `Le champ handle ne doit pas dépasser ${LONGUEUR_MAX_HANDLE} caractères`
    )
    .transform((valeur) => valeur.trim().toLowerCase())
    .refine(
      (valeur) => MOTIF_HANDLE.test(valeur),
      "Le champ handle ne doit contenir que des lettres minuscules, des chiffres et des tirets simples (exemple : etal-de-fatou)"
    ),
  phone: chaineObligatoire("phone", 32),
  whatsapp_phone: chaineObligatoire("whatsapp_phone", 32).optional(),
})

type CorpsInscription = z.infer<typeof schemaInscription>

const MESSAGE_DEJA_RATTACHE = "Cette identité est déjà rattachée à un marchand"

const messageHandlePris = (handle: string) =>
  `Le handle « ${handle} » est déjà utilisé par un autre marchand`

// L'orchestrateur de workflow rejette avec une copie en objet simple de
// l'erreur d'origine (`{message, name, stack}`), pas avec l'instance de
// `MedusaError` — constaté au test de compensation
// (integration-tests/http/merchant-provisioning.spec.ts). `instanceof` et
// `e.type` sont donc inutilisables ici : seul le message survit.
const messageDe = (e: unknown): string =>
  String((e as { message?: unknown })?.message ?? "")

// Le motif est délibérément spécifique au handle : un simple `already exists`
// attraperait aussi l'échec de rattachement d'identité ci-dessous, qui n'a
// rien à voir et mérite son propre statut.
const estCollisionDeHandle = (e: unknown): boolean =>
  /with handle: .*already exists|duplicate key|unique constraint/i.test(messageDe(e))

// `setAuthAppMetadataStep` refuse d'écraser un `merchant_id` déjà posé
// (node_modules/@medusajs/core-flows/dist/auth/steps/set-auth-app-metadata.js:44-47,
// `Key ${actorType}_id already exists in app metadata`). Ce chemin n'est
// atteint que par un jeton d'inscription réutilisé après une inscription
// réussie : le contexte d'authentification est reconstruit depuis la charge
// du JWT et non relu en base
// (node_modules/@medusajs/framework/dist/http/middlewares/authenticate-middleware.js:32-41),
// donc un tel jeton n'affiche pas d'`actor_id` et passe la garde d'entrée.
const estDejaRattache = (e: unknown): boolean =>
  /already exists in app metadata/i.test(messageDe(e))

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

// Le corps n'est volontairement pas typé : c'est une entrée non fiable tant
// que `schemaInscription` ne l'a pas validée. L'ancien typage (`<CorpsInscription>`)
// décrivait une promesse que rien ne tenait — un `handle: ["x"]` arrivait
// jusqu'à la base et y était coercé silencieusement en `"x"`.
export const POST = async (
  req: AuthenticatedMedusaRequest<unknown>,
  res: MedusaResponse
) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)

  // Une identité déjà rattachée qui rappelle cette route provisionnait un
  // canal, un emplacement et une clé avant d'échouer sur le rattachement et
  // de tout compenser — pour finir sur un 500 anglais. On la refuse avant de
  // toucher au workflow.
  if (req.auth_context.actor_id) {
    return res.status(409).json({ message: MESSAGE_DEJA_RATTACHE })
  }

  const validation = schemaInscription.safeParse(req.body)
  if (!validation.success) {
    return res.status(400).json({
      message: validation.error.issues.map((i) => i.message).join(" ; "),
    })
  }
  const corps = validation.data

  const service = req.scope.resolve<MerchantModuleService>(MERCHANT_MODULE)

  // Contrôle préalable : évite d'engager le workflow (et sa cascade de
  // compensations) pour l'échec le plus probable de cette route. La capture
  // plus bas reste indispensable — deux inscriptions concurrentes sur le même
  // handle passeraient toutes deux ce contrôle et seule la contrainte unique
  // de Postgres trancherait.
  const dejaPris = await service.listMerchants({ handle: corps.handle })
  if (dejaPris.length > 0) {
    return res.status(409).json({ message: messageHandlePris(corps.handle) })
  }

  let merchantId: string
  let publishableKey: string
  try {
    const { result } = await inscrireMarchandWorkflow(req.scope).run({
      input: { ...corps, auth_identity_id: req.auth_context.auth_identity_id },
    })
    merchantId = result.merchant_id
    publishableKey = result.publishable_key
  } catch (e) {
    if (estDejaRattache(e)) {
      return res.status(409).json({ message: MESSAGE_DEJA_RATTACHE })
    }
    if (estCollisionDeHandle(e)) {
      return res.status(409).json({ message: messageHandlePris(corps.handle) })
    }
    logger.error(
      `Échec de l'inscription du marchand « ${corps.handle} » : ${messageDe(e)}`
    )
    throw e
  }

  // On relit l'entité persistée plutôt que de renvoyer l'écho du corps reçu :
  // après normalisation, ce que le client a envoyé et ce que le serveur a
  // stocké peuvent différer (casse du handle, espaces rognés), et c'est la
  // seconde valeur qui fait foi. Mêmes sept champs que GET /merchant/me.
  const marchand = await service.retrieveMerchant(merchantId)
  const { id, name, handle, phone, whatsapp_phone, currency_code, status } = marchand

  res.json({
    merchant: { id, name, handle, phone, whatsapp_phone, currency_code, status },
    publishable_key: publishableKey,
  })
}
