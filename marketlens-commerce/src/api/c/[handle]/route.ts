import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { marchandEstActif } from "../../merchant/catalogues/scope"

/** Vitrine publique consultable au navigateur.
 *
 *  La route JSON `/store/catalogues/:handle` existe déjà, mais le framework
 *  monte `ensurePublishableApiKeyMiddleware` sur tout le namespace `/store` :
 *  elle exige un en-tête `x-publishable-api-key` qu'un navigateur ne pose pas
 *  en suivant un lien. Elle n'est donc pas partageable telle quelle — et la
 *  clé étant PAR marchand, une page publique ne peut de toute façon pas la
 *  connaître avant de savoir à qui appartient le handle.
 *
 *  Cette route sert la même vitrine en HTML, hors du namespace `/store`, en
 *  lisant les données côté serveur. Les règles de cloisonnement sont
 *  identiques et volontairement dupliquées depuis la route JSON : brouillon,
 *  handle inconnu et marchand non actif rendent tous la MÊME page introuvable,
 *  pour ne rien révéler.
 *
 *  Ce n'est pas la vitrine du lot 4 : c'est ce qu'on peut montrer et partager
 *  aujourd'hui. */

const echapper = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))

const PAGE_INTROUVABLE = `<!doctype html><html lang="fr"><meta charset="utf-8">
<title>Boutique introuvable</title>
<body style="margin:0;background:#0f1115;color:#e8eaed;font:16px/1.6 system-ui,sans-serif;
display:grid;place-items:center;height:100vh;text-align:center">
<div><h1 style="font-size:20px;margin:0 0 8px">Boutique introuvable</h1>
<p style="color:#9aa3b2;margin:0">Cette vitrine n'existe pas ou n'est plus en ligne.</p></div>
</body></html>`

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  const { data } = await query.graph({
    entity: "visual_catalogue",
    fields: [
      "id", "handle", "title", "annotated_image_url", "status",
      "merchant.id", "merchant.name", "merchant.status",
      "merchant.whatsapp_phone", "merchant.phone",
      "zones.id", "zones.detected_label",
      "zones.product.id", "zones.product.title",
      "zones.product.variants.id", "zones.product.variants.title",
    ],
    filters: { handle: req.params.handle, status: "published" },
  })

  const catalogue = data[0] as any
  res.setHeader("Content-Type", "text/html; charset=utf-8")

  if (!catalogue || !marchandEstActif(catalogue.merchant?.status)) {
    return res.status(404).send(PAGE_INTROUVABLE)
  }

  const marchand = catalogue.merchant
  const zones = (catalogue.zones ?? []).filter((z: any) => z.product)

  // Le numéro est repris tel quel de l'inscription : l'archive montre le même
  // marchand sous « 95206533 », « 22995206533 » et « +22995206533 ». La
  // normalisation E.164 est une décision de conception portée au lot suivant
  // (docs/superpowers/specs/notes-plan-4.md) — sans elle, un numéro local à
  // huit chiffres produit un lien wa.me qui ne joint personne.
  const wa = String(marchand.whatsapp_phone ?? marchand.phone ?? "").replace(/\D/g, "")

  const cartes = zones.map((z: any) => {
    const variantes = (z.product.variants ?? []).map((v: any) => v.title).filter(Boolean)
    return `<article class="carte">
      <h3>${echapper(z.product.title)}</h3>
      <p class="detecte">détecté sur la photo : ${echapper(z.detected_label)}</p>
      ${variantes.length > 1
        ? `<ul class="vars">${variantes.map((v: string) => `<li>${echapper(v)}</li>`).join("")}</ul>`
        : ""}
    </article>`
  }).join("")

  res.send(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${echapper(marchand.name)} — MarketLens</title>
<style>
 :root{--fond:#0f1115;--carte:#171a21;--bord:#262b36;--texte:#e8eaed;
   --doux:#9aa3b2;--accent:#ff8a3d;--vert:#25d366}
 *{box-sizing:border-box}
 body{margin:0;background:var(--fond);color:var(--texte);
   font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
 .haut{max-width:880px;margin:0 auto;padding:30px 22px 18px}
 h1{margin:0;font-size:23px;letter-spacing:-.3px}
 .sous{color:var(--doux);font-size:14px;margin:5px 0 0}
 .photo{max-width:880px;margin:8px auto 0;padding:0 22px}
 .photo img{width:100%;display:block;border-radius:12px;border:1px solid var(--bord)}
 .lgd{color:var(--doux);font-size:12.5px;text-align:center;margin:9px 0 0}
 .liste{max-width:880px;margin:26px auto 0;padding:0 22px;
   display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:13px}
 .carte{background:var(--carte);border:1px solid var(--bord);border-radius:11px;padding:14px 16px}
 .carte h3{margin:0;font-size:15.5px}
 .detecte{color:var(--doux);font-size:11.5px;margin:5px 0 0}
 .vars{margin:10px 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:5px}
 .vars li{font-size:11.5px;color:var(--doux);border:1px solid var(--bord);
   border-radius:20px;padding:2px 9px}
 .contact{max-width:880px;margin:26px auto 60px;padding:0 22px}
 .wa{display:inline-flex;align-items:center;gap:9px;background:var(--vert);color:#04310f;
   text-decoration:none;font-weight:650;padding:12px 20px;border-radius:9px}
 .note{color:var(--doux);font-size:12px;margin:11px 0 0}
 footer{border-top:1px solid var(--bord);text-align:center;padding:18px;
   color:var(--doux);font-size:12px}
 footer b{color:var(--accent)}
</style></head><body>
<div class="haut">
  <h1>${echapper(marchand.name)}</h1>
  <p class="sous">${echapper(catalogue.title)} · ${zones.length} produit(s) en vente</p>
</div>
<div class="photo">
  <img src="${echapper(catalogue.annotated_image_url)}" alt="Étal de ${echapper(marchand.name)}">
  <p class="lgd">La vraie photo de l'étal. Les prix sont affichés sur les produits.</p>
</div>
<div class="liste">${cartes}</div>
<div class="contact">
  ${wa ? `<a class="wa" href="https://wa.me/${wa}">Contacter ${echapper(marchand.name)} sur WhatsApp</a>` : ""}
  <p class="note">L'acheteur commande directement auprès de la vendeuse.</p>
</div>
<footer>Propulsé par <b>MarketLens</b></footer>
</body></html>`)
}
