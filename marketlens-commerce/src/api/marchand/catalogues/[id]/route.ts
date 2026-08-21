import { MedusaResponse } from "@medusajs/framework/http"
import { brut, html } from "../../../../lib/html"
import { page, pageIntrouvable } from "../../../../lib/pages/layout"
import { RequetePageMarchand } from "../../garde"
import { detailCatalogueDuMarchand } from "../../../merchant/catalogues/scope"

// Envoi en JavaScript, comme src/api/marchand/nouveau/route.ts : publier
// sans recharger la page permet d'afficher le message français rendu par la
// route amont, et de désactiver le bouton pendant l'appel. Contenu de CE
// dépôt uniquement (jamais une valeur venue de la base ou du service de
// vision) : légitime à insérer via `brut`.
//
// Les libellés détectés viennent de Gemini, donc d'un tiers : ce script ne
// pose JAMAIS de HTML via `innerHTML` sur une valeur qui en proviendrait —
// il ne lit que `.value` sur des `<input>` (qui n'interprètent jamais leur
// contenu comme du balisage) et n'écrit que via `textContent`.
const SCRIPT = `
const liste = (v) => v.split(",").map(s => s.trim()).filter(Boolean)
function recalculer(tr) {
  const q = Number(tr.querySelector("[data-qte]").value) || 0
  const c = Math.max(1, liste(tr.querySelector("[data-coul]").value).length)
  const t = Math.max(1, liste(tr.querySelector("[data-tail]").value).length)
  const n = c * t
  tr.querySelector("[data-total]").textContent =
    n > 1 ? q + " par déclinaison × " + n + " déclinaisons = " + (q * n) + " en stock"
          : q + " en stock"
}
document.querySelectorAll("tr[data-zone]").forEach(tr => {
  tr.querySelectorAll("input").forEach(i => i.oninput = () => recalculer(tr))
  recalculer(tr)
})
document.getElementById("publier").onclick = async () => {
  const items = []
  for (const tr of document.querySelectorAll("tr[data-zone]")) {
    if (!tr.querySelector("[data-vendre]").checked) continue
    items.push({
      zone_id: tr.dataset.zone,
      label: tr.querySelector("[data-lib]").value.trim(),
      price: tr.querySelector("[data-prix]").value.trim(),
      quantity: Number(tr.querySelector("[data-qte]").value),
      colors: liste(tr.querySelector("[data-coul]").value),
      sizes: liste(tr.querySelector("[data-tail]").value),
    })
  }
  const msg = document.getElementById("msg")
  if (items.length === 0) {
    msg.className = "err"
    msg.textContent = "Cochez au moins un produit à mettre en vente."
    return
  }
  document.getElementById("publier").disabled = true
  msg.className = "ok"; msg.textContent = "Publication en cours…"
  const r = await fetch(location.pathname.replace("/marchand/", "/merchant/") + "/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) {
    // Message rendu tel quel par la route amont, déjà en français : ne pas
    // le réécrire ni le masquer derrière un repli générique. Le repli ne
    // s'active que si la réponse n'est pas du JSON exploitable.
    msg.className = "err"
    msg.textContent = d.message || "La publication a échoué."
    document.getElementById("publier").disabled = false
    return
  }
  location.href = "/marchand"
}
`

// Aucune garde à appeler ici, et aucune sortie anticipée à ne pas oublier :
// `authentifierPageMarchand` a déjà refusé — avant le routage — tout ce qui
// n'est pas un marchand actif, et a posé le marchand résolu sur la requête.
// `req.marchand` est non nullable (voir `RequetePageMarchand`).
export const GET = async (req: RequetePageMarchand, res: MedusaResponse) => {
  const marchand = req.marchand

  const detail = await detailCatalogueDuMarchand(req.scope, marchand.id, req.params.id)
  if (!detail) {
    // Catalogue inexistant et catalogue d'autrui rendent EXACTEMENT la même
    // page : un message distinct confirmerait l'existence du second à qui
    // ne devrait pas la connaître.
    res.setHeader("Content-Type", "text/html; charset=utf-8")
    return res.status(404).send(pageIntrouvable())
  }
  if (detail.status === "published") {
    // Cet écran ne sait tarifer qu'un BROUILLON : un catalogue déjà publié
    // se corrige ailleurs (écran de la tâche 8, pas encore livré — la
    // redirection reste correcte même si la cible rend 404 pour l'instant).
    return res.redirect(302, `/marchand/catalogues/${detail.id}/prix`)
  }

  const lignes = detail.zones.map(
    (z) => html`
      <tr data-zone="${z.id}">
        <td><input type="checkbox" data-vendre checked style="width:auto"></td>
        <td>
          <input data-lib value="${z.detected_label}">
          <div class="sous" style="margin:3px 0 0">reconnu : ${z.detected_label}</div>
        </td>
        <td><input data-prix value="1000" inputmode="numeric"></td>
        <td><input data-qte value="1" inputmode="numeric"></td>
        <td><input data-coul placeholder="rouge, bleu"></td>
        <td><input data-tail placeholder="M, L"></td>
      </tr>
      <tr><td></td><td colspan="5" class="sous"><span data-total></span></td></tr>`
  )

  const corps = html`
    <h1>${detail.title}</h1>
    <p class="sous">Mettez vos prix, puis publiez.</p>
    ${detail.annotated_image_url
      ? html`<img src="${detail.annotated_image_url}" alt="">`
      : null}
    <div class="carte">
      <table>
        <thead><tr>
          <th style="width:34px">Vendre</th><th>Produit</th><th style="width:110px">Prix (FCFA)</th>
          <th style="width:120px">Quantité par déclinaison</th><th>Couleurs</th><th>Tailles</th>
        </tr></thead>
        <tbody>${lignes}</tbody>
      </table>
      <button id="publier">Publier mon catalogue</button>
      <div id="msg" style="margin-top:14px"></div>
    </div>
    <script>${brut(SCRIPT)}</script>`

  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.send(page({ titre: detail.title, marchand: marchand.name, corps }))
}
