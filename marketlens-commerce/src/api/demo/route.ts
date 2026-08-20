import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import fs from "fs"
import path from "path"

/** Harnais de démonstration, servi par Medusa lui-même.
 *
 *  Servi depuis la MÊME origine que l'API (localhost:9000) délibérément : les
 *  routes /merchant/* sont un namespace maison, donc aucun en-tête CORS ne leur
 *  est posé par le framework (qui n'en configure que pour /store, /admin et
 *  /auth). Une page ouverte depuis file:// ou un autre port serait bloquée par
 *  le navigateur avant même d'atteindre l'authentification. En même origine, la
 *  question ne se pose pas.
 *
 *  Ce n'est pas le back-office du lot 4 : c'est un banc d'essai qui montre le
 *  parcours réel de bout en bout sans rien simuler. */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const page = path.join(process.cwd(), "src", "api", "demo", "page.html")
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.send(fs.readFileSync(page, "utf-8"))
}
