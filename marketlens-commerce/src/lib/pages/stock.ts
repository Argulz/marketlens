// Calcul du stock visible sur l'écran de tarification (finding R14 de la
// ronde de correction 1). Décision produit D5 rendue visible ici : la
// quantité saisie par la commerçante est PAR DÉCLINAISON, pas répartie —
// « 4 par déclinaison x 4 déclinaisons (2 couleurs, 2 tailles) = 16 en
// stock », contre-intuitif, d'où l'affichage en clair et les tests ci-après.
//
// Contrainte structurante : `src/api/marchand/catalogues/[id]/route.ts`
// injecte ces fonctions dans la page en sérialisant leur code
// (`fonction.toString()`) plutôt qu'en recopiant leur corps dans un gabarit
// — c'est ce qui garantit que le code exercé par
// `integration-tests/modules/stock.spec.ts` est EXACTEMENT celui livré au
// navigateur. En conséquence, aucune de ces fonctions ne doit fermer sur une
// variable extérieure ni sur un import : seulement leurs paramètres et des
// primitifs JavaScript (Number, Math). Une fonction peut en revanche en
// appeler une autre de ce module, tant que toutes les fonctions utilisées
// sont injectées ensemble (déclarations de fonction, donc « hoistées »).

/** Résultat de la lecture d'une quantité saisie en texte. `valide: false`
 *  ne porte aucune valeur : il n'y a rien de sûr à afficher ni à envoyer. */
export type QuantiteLue = { valide: true; valeur: number } | { valide: false }

/** Lit la quantité par déclinaison saisie par la commerçante. Reprend
 *  exactement la règle du serveur de publication
 *  (`valider-items-publication.ts` : entier positif ou nul) plutôt qu'une
 *  règle plus permissive côté écran — c'est la divergence que corrige le
 *  finding R13 : avant, un champ vide au moment de l'AFFICHAGE valait 0
 *  (`Number(v) || 0`) mais un champ non numérique, à l'ENVOI, partait tel
 *  quel en `NaN` puis en `null` JSON, refusé par le serveur sans rapport
 *  apparent avec ce que la commerçante venait de lire. Une seule fonction
 *  sert désormais aux deux usages : la même lecture, le même verdict. */
export function lireQuantite(brut: string): QuantiteLue {
  const v = Number(brut)
  if (!Number.isInteger(v) || v < 0) return { valide: false }
  return { valide: true, valeur: v }
}

/** Nombre de déclinaisons obtenu en croisant couleurs et tailles. Au moins
 *  une déclinaison de chaque axe : une commerçante qui ne renseigne ni
 *  couleur ni taille vend quand même « une » déclinaison de son produit. */
export function compterDeclinaisons(couleurs: string[], tailles: string[]): number {
  return Math.max(1, couleurs.length) * Math.max(1, tailles.length)
}

/** Stock total = quantité PAR DÉCLINAISON × nombre de déclinaisons (D5). */
export function calculerStockTotal(quantite: number, declinaisons: number): number {
  return quantite * declinaisons
}

/** Texte annoncé à la commerçante pour une ligne du tableau de tarification :
 *  l'erreur si la quantité saisie est invalide (finding R13 — elle doit le
 *  savoir avant de cliquer sur Publier, pas après un refus serveur sans
 *  rapport apparent), sinon le détail du calcul dès qu'il y a plusieurs
 *  déclinaisons, sinon la quantité seule. */
export function texteStock(quantite: QuantiteLue, declinaisons: number): string {
  if (!quantite.valide) {
    return "Quantité invalide : entrez un nombre entier positif ou nul."
  }
  const total = calculerStockTotal(quantite.valeur, declinaisons)
  return declinaisons > 1
    ? quantite.valeur + " par déclinaison × " + declinaisons + " déclinaisons = " + total + " en stock"
    : quantite.valeur + " en stock"
}

// Chaîne effectivement injectée dans la page (voir
// `src/api/marchand/catalogues/[id]/route.ts`), obtenue en sérialisant le
// code source de chaque fonction ci-dessus (`.toString()`) plutôt qu'en le
// recopiant dans un gabarit. Définie ici, à côté des fonctions dont elle
// dépend, plutôt que dans la route : il ne peut plus exister qu'une seule
// définition de ce qui part au navigateur, et `integration-tests/modules/
// stock.spec.ts` peut l'évaluer directement (garde `new Function`) plutôt
// que de se fier à la seule présence des noms de fonctions dans la page.
export const SCRIPT_STOCK = [lireQuantite, compterDeclinaisons, calculerStockTotal, texteStock]
  .map((f) => f.toString())
  .join("\n\n")
