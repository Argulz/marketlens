// Gabarit commun à tout le back-office marchand : un seul en-tête, un seul
// jeu de styles, pour que chaque écran (connexion, liste, photo, prix) rende
// une page cohérente sans dupliquer de balisage.
import { HtmlSur, brut, html, rendre } from "../html"

// Les styles sont du contenu de ce dépôt, jamais une donnée : `brut` est
// justifié ici et nulle part ailleurs dans ce fichier.
const STYLES = `
:root{--fond:#0f1115;--carte:#171a21;--bord:#262b36;--texte:#e8eaed;
  --doux:#9aa3b2;--accent:#ff8a3d;--ok:#3ddc97;--err:#ff5c6c}
*{box-sizing:border-box}
body{margin:0;background:var(--fond);color:var(--texte);
  font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{border-bottom:1px solid var(--bord);padding:16px 20px;
  display:flex;align-items:center;justify-content:space-between;gap:12px}
header a{color:var(--texte);text-decoration:none;font-weight:650}
header .qui{color:var(--doux);font-size:13.5px}
main{max-width:820px;margin:0 auto;padding:22px 20px 70px}
h1{font-size:21px;margin:0 0 4px}
.sous{color:var(--doux);font-size:14px;margin:0 0 20px}
.carte{background:var(--carte);border:1px solid var(--bord);
  border-radius:11px;padding:16px 18px;margin-bottom:12px}
label{display:block;font-size:12.5px;color:var(--doux);margin:12px 0 5px}
input,select{width:100%;padding:11px 12px;background:#0e1016;color:var(--texte);
  border:1px solid var(--bord);border-radius:8px;font:inherit}
button{margin-top:16px;padding:12px 20px;background:var(--accent);color:#2b1200;
  border:0;border-radius:8px;font:inherit;font-weight:650;cursor:pointer}
button.sec{background:transparent;color:var(--doux);border:1px solid var(--bord)}
.err{background:#2a1216;color:var(--err);border:1px solid #4a1f27;
  padding:11px 13px;border-radius:8px;margin-bottom:14px}
.ok{background:#0f2a20;color:var(--ok);border:1px solid #1c4636;
  padding:11px 13px;border-radius:8px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--doux);font-size:11.5px;text-transform:uppercase;
  letter-spacing:.05em;padding:0 8px 7px;font-weight:500}
td{padding:6px 8px;border-top:1px solid var(--bord)}
img{max-width:100%;border-radius:9px;display:block}
a.lien{color:var(--accent)}
`

/** Un seul gabarit pour toutes les pages du back-office. Le titre et le nom de
 *  la boutique passent par `html`, donc sont échappés : un nom de boutique
 *  hostile ne peut pas s'évader de l'en-tête. */
export function page(options: {
  titre: string
  marchand?: string
  corps: HtmlSur
}): string {
  const entete = options.marchand
    ? html`<header>
        <a href="/marchand">MarketLens</a>
        <span class="qui">${options.marchand} ·
          <a class="lien" href="/marchand/deconnexion?action=sortir">Se déconnecter</a>
        </span>
      </header>`
    : html`<header><a href="/marchand">MarketLens</a></header>`

  return (
    "<!doctype html>" +
    rendre(html`<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${options.titre} — MarketLens</title>
<style>${brut(STYLES)}</style></head><body>${entete}<main>${options.corps}</main></body></html>`)
  )
}

/** Page 404 commune à toutes les routes du back-office marchand. Servie à
 *  l'identique pour un identifiant qui n'existe pas et pour le catalogue
 *  d'une autre commerçante : ne jamais nommer « boutique » ou « catalogue »
 *  ici, sous peine de confirmer par la formulation quel cas s'est produit. */
export function pageIntrouvable(): string {
  return page({
    titre: "Introuvable",
    corps: html`<h1>Introuvable</h1>
      <p class="sous">Cette page n'existe pas, ou vous n'y avez pas accès.</p>`,
  })
}
