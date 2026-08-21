// Gabarit littéral auto-échappant pour le back-office marchand, rendu en HTML
// par Medusa lui-même (pas de moteur de vues tiers). Toute interpolation est
// échappée par défaut ; le contournement (`brut`) est explicite et rare, ce
// qui rend une injection accidentelle très visible en revue.

/** Marqueur de HTML déjà sûr. Le champ est `readonly` et le type n'est pas
 *  exporté comme constructible : la seule façon d'en obtenir un est `html` ou
 *  `brut`, ce qui rend l'échappement non contournable par accident. */
export type HtmlSur = { readonly __html: string }

const ENTITES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

/** Les guillemets et l'apostrophe comptent autant que les chevrons : une valeur
 *  interpolée dans un attribut s'en échappe sans jamais ouvrir de balise. */
function echapper(valeur: string): string {
  return valeur.replace(/[&<>"']/g, (c) => ENTITES[c])
}

function estSur(v: unknown): v is HtmlSur {
  return typeof v === "object" && v !== null && "__html" in v
}

// `null`/`undefined`/`false` s'effacent plutôt que de rendre la chaîne
// "null" ou "undefined" : un champ optionnel non renseigné ne doit pas
// polluer visuellement une page.
function convertir(valeur: unknown): string {
  if (valeur === null || valeur === undefined || valeur === false) return ""
  if (estSur(valeur)) return valeur.__html
  if (Array.isArray(valeur)) return valeur.map(convertir).join("")
  return echapper(String(valeur))
}

export function html(
  chaines: TemplateStringsArray,
  ...valeurs: unknown[]
): HtmlSur {
  let sortie = chaines[0]
  for (let i = 0; i < valeurs.length; i++) {
    sortie += convertir(valeurs[i]) + chaines[i + 1]
  }
  return { __html: sortie }
}

/** Insère du HTML sans l'échapper. À n'utiliser que sur du contenu dont
 *  l'origine est le code de ce dépôt — jamais sur une valeur venue de la base,
 *  d'un formulaire ou d'un service amont. */
export function brut(s: string): HtmlSur {
  return { __html: s }
}

export function rendre(h: HtmlSur): string {
  return h.__html
}
