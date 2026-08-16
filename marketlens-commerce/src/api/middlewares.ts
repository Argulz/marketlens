import { defineMiddlewares, authenticate } from "@medusajs/framework/http"

export default defineMiddlewares({
  routes: [
    {
      // L'inscription accepte une identité pas encore rattachée à un marchand.
      matcher: "/merchant/register",
      method: "POST",
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
      // tableau (vérifié empiriquement — un simple `method: "POST"` sur cette
      // règle ne suffit pas non plus, le groupe "wildcard" d'un matcher en
      // `*` restant prioritaire sur le groupe "static" d'un matcher exact).
      // Sans cette exclusion, la règle générale interceptait l'inscription
      // avant la règle spécifique et renvoyait 401 même avec un jeton valide.
      matcher: /^\/merchant\/(?!register(?:\/|$)).*/,
      middlewares: [authenticate("merchant", ["session", "bearer"])],
    },
  ],
})
