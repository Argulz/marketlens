/**
 * Marqueur porté par les erreurs de SAISIE (entrée du client) levées par les
 * étapes de validation de la publication — à distinguer de toute autre
 * panne (base de données, service de vision, etc.), qui doit rendre 500 et
 * jamais 400.
 *
 * Pourquoi un nom plutôt qu'`instanceof` : le rejet d'un `.run()` de
 * workflow n'est jamais l'instance d'erreur d'origine — l'orchestrateur la
 * remplace par une COPIE en objet simple avant de la propager (constaté au
 * pitfall documenté sur ce chantier, et confirmé par lecture directe de
 * node_modules/@medusajs/utils/dist/common/serialize-error.js : `serializeError`
 * copie `message`, `name`, `stack`, puis TOUTES les propriétés propres de
 * l'erreur — et node_modules/@medusajs/workflows-sdk/dist/helper/workflow-export.js
 * (`errors?.[0]?.error`) est précisément ce qui atteint le `catch` de la
 * route). `error instanceof ErreurValidationPublication` serait donc
 * toujours `false` sur ce chemin ; `error.name` survit, lui, intact.
 */
export const NOM_ERREUR_VALIDATION_PUBLICATION = "ErreurValidationPublication"

export class ErreurValidationPublication extends Error {
  constructor(message: string) {
    super(message)
    this.name = NOM_ERREUR_VALIDATION_PUBLICATION
  }
}
