import { MedusaResponse } from "@medusajs/framework/http"
import { brut, html } from "../../../lib/html"
import { page } from "../../../lib/pages/layout"
import { RequetePageMarchand } from "../garde"
import { TAILLE_MAX_IMAGE_MO } from "../../../lib/limites-image"

// Envoi en JavaScript plutôt qu'en <form> classique : il faut dessiner les
// zones détectées par-dessus l'aperçu de la photo sans recharger la page.
// Contenu de CE dépôt uniquement — jamais une valeur venue de la base, d'un
// formulaire ou d'un service amont — donc légitime à insérer via `brut`.
const SCRIPT = `
const $ = (i) => document.getElementById(i)
$("photo").onchange = () => {
  const f = $("photo").files[0]; if (!f) return
  $("apercu").src = URL.createObjectURL(f)
  $("scene").style.display = "block"
  document.querySelectorAll(".zone").forEach(z => z.remove())
}
$("envoyer").onclick = async () => {
  const f = $("photo").files[0]
  if (!f) { $("msg").className = "err"; $("msg").textContent = "Choisissez une photo."; return }
  $("envoyer").disabled = true
  $("msg").className = "ok"; $("msg").textContent = "Analyse de la photo en cours…"
  const fd = new FormData()
  fd.append("image", f); fd.append("title", $("titre").value.trim())
  const r = await fetch("/merchant/catalogues", { method: "POST", body: fd })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) {
    // Le message vient de la route amont, déjà en français et déjà distinct
    // entre une photo refusée (400) et une panne du service de vision (503) :
    // on l'affiche tel quel, sans le réécrire ni inventer un repli qui le
    // masquerait.
    $("msg").className = "err"
    $("msg").textContent = d.message || "L'analyse a échoué. Réessayez."
    $("envoyer").disabled = false
    return
  }
  for (const z of d.zones) {
    const e = document.createElement("div")
    e.className = "zone"
    // Géométrie rendue sur une échelle de 0 à 1000 par le service de vision :
    // /10 pour obtenir des pourcentages.
    e.style.cssText = "position:absolute;border:2px solid #ff8a3d;border-radius:3px;"
      + "background:rgba(255,138,61,.11);left:" + (z.x/10) + "%;top:" + (z.y/10)
      + "%;width:" + (z.width/10) + "%;height:" + (z.height/10) + "%"
    const b = document.createElement("b")
    b.style.cssText = "position:absolute;top:-1px;left:-1px;background:#ff8a3d;"
      + "color:#2b1200;font:600 11px/1.5 sans-serif;padding:1px 6px;border-radius:3px 0 3px 0"
    b.textContent = z.detected_label
    e.appendChild(b); $("scene").appendChild(e)
  }
  $("msg").className = "ok"
  $("msg").textContent = d.zones.length + " produit(s) reconnu(s). Passez aux prix."
  $("suite").href = "/marchand/catalogues/" + d.catalogue.id
  $("suite").style.display = "inline-block"
}
`

// Aucune garde à appeler ici, et aucune sortie anticipée à ne pas oublier :
// `authentifierPageMarchand` a déjà refusé — avant le routage — tout ce qui
// n'est pas un marchand actif, et a posé le marchand résolu sur la requête.
// `req.marchand` est non nullable (voir `RequetePageMarchand`).
export const GET = async (req: RequetePageMarchand, res: MedusaResponse) => {
  const marchand = req.marchand

  const corps = html`
    <h1>Photographier mon étal</h1>
    <p class="sous">Prenez la photo comme vous la montreriez à un client.</p>
    <div class="carte">
      <label for="titre">Nom de ce catalogue</label>
      <input id="titre" value="Étal du jour">
      <label for="photo">Photo</label>
      <input id="photo" type="file" accept="image/jpeg,image/png,image/webp"
             capture="environment">
      <div class="sous" style="margin-top:6px">
        JPEG, PNG ou WebP, moins de ${TAILLE_MAX_IMAGE_MO} Mo.
      </div>
      <button id="envoyer">Analyser la photo</button>
      <a id="suite" href="#" style="display:none;margin-left:10px">
        <button class="sec">Passer aux prix</button>
      </a>
      <div id="msg" style="margin-top:14px"></div>
      <div id="scene" style="position:relative;display:none;margin-top:14px">
        <img id="apercu" alt="">
      </div>
    </div>
    <script>${brut(SCRIPT)}</script>`

  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.send(page({ titre: "Nouveau catalogue", marchand: marchand.name, corps }))
}
