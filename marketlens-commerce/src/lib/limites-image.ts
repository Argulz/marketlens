/**
 * Taille maximale d'une photo d'étal acceptée par la route de téléversement.
 *
 * Une seule source de vérité, partagée par les deux endroits qui doivent
 * s'accorder : la limite `multer` de src/api/middlewares.ts (qui refuse la
 * requête avant de la bufferiser) et le message français rendu au marchand
 * par POST /merchant/catalogues. Deux constantes séparées divergeraient, et
 * le marchand lirait alors une limite qui n'est pas celle appliquée.
 *
 * La valeur est calée SOUS les 20 Mo du service de vision
 * (`MAX_IMAGE_BYTES`, services/vision/app/config.py) pour que le refus
 * tombe ici — tôt, sans transfert inutile ni copie en mémoire — plutôt qu'en
 * 413 après l'aller-retour. Elle reste AU-DESSUS du cas nominal : une photo
 * d'étal prise avec un téléphone récent pèse couramment 8 à 15 Mo, et ce
 * cas-là ne doit jamais être refusé.
 */
export const TAILLE_MAX_IMAGE_MO = 18

export const TAILLE_MAX_IMAGE_OCTETS = TAILLE_MAX_IMAGE_MO * 1024 * 1024
