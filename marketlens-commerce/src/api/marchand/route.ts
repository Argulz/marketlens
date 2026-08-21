import { MedusaResponse } from "@medusajs/framework/http"
import { html } from "../../lib/html"
import { page } from "../../lib/pages/layout"
import { RequetePageMarchand } from "./garde"
import { CatalogueDuMarchand, cataloguesDuMarchand } from "../merchant/catalogues/scope"

// Aucune garde à appeler ici, et aucune sortie anticipée à ne pas oublier :
// `authentifierPageMarchand` a déjà refusé — avant le routage — tout ce qui
// n'est pas un marchand actif, et a posé le marchand résolu sur la requête.
// `req.marchand` est non nullable (voir `RequetePageMarchand`).
export const GET = async (req: RequetePageMarchand, res: MedusaResponse) => {
  const marchand = req.marchand

  const catalogues = await cataloguesDuMarchand(req.scope, marchand.id)
  const brouillons = catalogues.filter((c) => c.status !== "published")
  const publies = catalogues.filter((c) => c.status === "published")

  const carte = (c: CatalogueDuMarchand, publie: boolean) => html`
    <div class="carte">
      <b>${c.title}</b>
      <div class="sous" style="margin:4px 0 0">
        ${publie
          ? html`En ligne · <a class="lien" href="/c/${c.handle}">voir la vitrine</a>`
          : "Brouillon — prix à saisir"}
      </div>
      <a class="lien" href="/marchand/catalogues/${c.id}${publie ? "/prix" : ""}">
        ${publie ? "Corriger les prix" : "Terminer et publier"}
      </a>
    </div>`

  const corps = html`
    <h1>Mes catalogues</h1>
    <p class="sous">${marchand.name}</p>
    <a href="/marchand/nouveau"><button>Photographier mon étal</button></a>
    ${brouillons.length ? html`<h2>À terminer</h2>` : null}
    ${brouillons.map((c) => carte(c, false))}
    ${publies.length ? html`<h2>En ligne</h2>` : null}
    ${publies.map((c) => carte(c, true))}
    ${catalogues.length === 0
      ? html`<div class="carte">Aucun catalogue pour l'instant.</div>`
      : null}`

  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.send(page({ titre: "Mes catalogues", marchand: marchand.name, corps }))
}
