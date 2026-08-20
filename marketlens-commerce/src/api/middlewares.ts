import { defineMiddlewares, authenticate } from "@medusajs/framework/http"

export default defineMiddlewares({
  routes: [
    {
      // L'inscription accepte une identité pas encore rattachée à un marchand.
      // On déclare `methods` (pluriel) plutôt que `method` (singulier) parce
      // que c'est le champ que le loader lit ensuite. `method` fonctionnerait
      // aussi — `defineMiddlewares` le replie sur `methods` quand ce dernier
      // est absent (node_modules/@medusajs/framework/dist/http/utils/define-middlewares.js:15-18)
      // — mais il est marqué @deprecated dans le SDK. `methods` est donc la
      // forme à écrire ; ce n'est pas une correction de bug, c'est le champ
      // non déprécié.
      //
      // Ce matcher est en correspondance *exacte* : une règle portant une
      // méthode HTTP est enregistrée via `app[method](matcher, handler)`
      // (node_modules/@medusajs/framework/dist/http/router.js:230), et non via
      // `app.use`. Elle ne couvre donc pas les sous-chemins de
      // /merchant/register — c'est la règle générale ci-dessous qui doit les
      // couvrir.
      matcher: "/merchant/register",
      methods: ["POST"],
      middlewares: [
        authenticate("merchant", ["bearer"], { allowUnregistered: true }),
      ],
    },
    {
      // La règle d'inscription ci-dessus ne couvre que POST, et le matcher
      // général exclut /merchant/register pour tous les verbes. Sans cette
      // règle, tout autre verbe sur ce chemin serait non authentifié.
      matcher: "/merchant/register",
      methods: ["GET", "PUT", "PATCH", "DELETE"],
      middlewares: [authenticate("merchant", ["session", "bearer"])],
    },
    {
      // Tout le reste exige une identité déjà rattachée. Le matcher exclut
      // explicitement /merchant/register par une négation dans l'expression
      // régulière : dans ce SDK, RoutesSorter classe les règles sans méthode
      // HTTP explicite dans un groupe de priorité qui s'exécute avant les
      // règles à méthode unique, quel que soit l'ordre de déclaration dans ce
      // tableau. Sans cette exclusion, la règle générale interceptait
      // l'inscription avant la règle spécifique et renvoyait 401 même avec
      // un jeton valide.
      //
      // La forme retenue couvre trois chemins qu'une exclusion plus large
      // laissait tomber hors de toute règle (donc non authentifiés) :
      //   - `/merchant` sans barre finale : `^\/merchant(?:\/...)?$` rend le
      //     segment suivant optionnel, donc une future src/api/merchant/route.ts
      //     naît authentifiée ;
      //   - `/merchant/register/**` : la négation ne porte que sur
      //     `register` en fin de chemin (`register\/?$`), donc une future
      //     src/api/merchant/register/confirm/route.ts naît authentifiée. La
      //     règle POST ci-dessus ne la couvrirait pas : elle est en
      //     correspondance exacte ;
      //   - `/merchant/register` et `/merchant/register/` restent, eux, hors
      //     de cette règle — c'est le seul chemin volontairement ouvert.
      //
      // Le drapeau `i` est indispensable : un matcher `RegExp` est utilisé
      // tel quel par Express (contrairement à un matcher chaîne, qu'Express
      // compile insensible à la casse par défaut). Sans lui, une requête sur
      // une variante de casse (`/Merchant/...`) ne matchait ni cette règle
      // ni la règle d'inscription, mais atteignait quand même la route
      // Express réelle si son propre matcher est, lui, insensible à la casse
      // — un contournement total de l'authentification pour toute future
      // route sous /merchant/*.
      matcher: /^\/merchant(?:\/(?!register\/?$).*)?$/i,
      middlewares: [authenticate("merchant", ["session", "bearer"])],
    },
  ],
})
