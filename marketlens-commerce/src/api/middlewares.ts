import { defineMiddlewares, authenticate } from "@medusajs/framework/http"

export default defineMiddlewares({
  routes: [
    {
      // L'inscription accepte une identité pas encore rattachée à un marchand.
      // `methods` (pluriel) est le champ lu par le loader : `method`
      // (singulier) est marqué @deprecated dans le SDK et n'est jamais lu au
      // runtime — le laisser seul aurait rendu cette règle permissive pour
      // tous les verbes HTTP sur /merchant/register, pas seulement POST.
      matcher: "/merchant/register",
      methods: ["POST"],
      middlewares: [
        authenticate("merchant", ["bearer"], { allowUnregistered: true }),
      ],
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
      // Le drapeau `i` est indispensable : un matcher `RegExp` est utilisé
      // tel quel par Express (contrairement à un matcher chaîne, qu'Express
      // compile insensible à la casse par défaut). Sans lui, une requête sur
      // une variante de casse (`/Merchant/...`) ne matchait ni cette règle
      // ni la règle d'inscription, mais atteignait quand même la route
      // Express réelle si son propre matcher est, lui, insensible à la casse
      // — un contournement total de l'authentification pour toute future
      // route sous /merchant/*.
      matcher: /^\/merchant\/(?!register(?:\/|$)).*/i,
      middlewares: [authenticate("merchant", ["session", "bearer"])],
    },
  ],
})
