// `handle` est destiné à devenir un segment d'URL publique (`/c/<handle>`).
// Deux couches valident ce champ : le schéma zod de la route d'inscription
// (src/api/merchant/register/route.ts, réponse 400 propre) et l'étape de
// création du marchand (src/workflows/steps/create-merchant-record.ts, filet
// pour tout appel direct au workflow — script d'opérateur, autre workflow,
// script d'import du corpus). Les deux DOIVENT partager le même motif et la
// même borne de longueur : deux constantes dupliquées valent identiques
// aujourd'hui par coïncidence, pas par garantie, et divergent à la première
// évolution — c'est exactement ce qui s'est produit ici (la route bornait à
// 64 caractères, l'étape ne bornait rien du tout, faute d'un import de cette
// borne). La colonne `handle` en base est un `model.text()` sans contrainte
// de longueur (src/modules/merchant/models/merchant.ts) : rien côté Postgres
// ne rattraperait un dépassement.
export const MOTIF_HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const LONGUEUR_MAX_HANDLE = 64
