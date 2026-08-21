import {
  defineMiddlewares,
  authenticate,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import multer from "multer"
import { TAILLE_MAX_IMAGE_MO, TAILLE_MAX_IMAGE_OCTETS } from "../lib/limites-image"
import { authentifierPageMarchand } from "./marchand/garde"

// `@medusajs/framework/http` n'exporte aucun `upload` prêt à l'emploi dans
// cette version du SDK (vérifié : absent de son `index.js`) — seul le code
// interne de `@medusajs/medusa` (route `/admin/uploads`) construit le sien
// ainsi, en mémoire. On reproduit exactement le même motif plutôt que
// d'écrire sur disque : les fichiers doivent transiter jusqu'à
// `uploadFilesWorkflow`, qui attend un contenu en mémoire, pas un chemin.
//
// `limits` n'est PAS décoratif ici. Sans plafond, toute photo était
// bufferisée intégralement en mémoire puis convertie en chaîne "binary" par
// la route — deux à trois copies du fichier par requête concurrente, sur un
// chemin ouvert à tout marchand authentifié. `files: 1` ferme la variante par
// le nombre : `upload.array("image")` accepterait sinon autant de fichiers
// que l'appelant en envoie, alors que la route n'en lit qu'un
// (`req.files?.[0]`).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TAILLE_MAX_IMAGE_OCTETS, files: 1 },
})

/**
 * `upload.array` signale un dépassement de limite par une `MulterError`
 * passée à `next()`. Laissée filer, elle atteint le gestionnaire d'erreurs du
 * framework qui rend un 500 portant son message ANGLAIS (« File too large »)
 * — une panne serveur apparente pour ce qui est une entrée refusable, et un
 * message que le marchand ne peut pas lire. On la traduit donc ici, au plus
 * près de l'endroit qui la produit.
 */
const televerserImage = (
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) => {
  upload.array("image")(req as any, res as any, (erreur: any) => {
    if (!erreur) return next()

    if (erreur.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        message: `L'image dépasse la taille maximale autorisée (${TAILLE_MAX_IMAGE_MO} Mo). Réduisez sa résolution ou sa qualité, puis réessayez.`,
      })
    }
    if (erreur.code === "LIMIT_FILE_COUNT" || erreur.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({
        message: "Envoyez une seule image par catalogue, dans le champ « image ».",
      })
    }
    // Toute autre défaillance de l'analyse multipart (corps tronqué,
    // frontière invalide) reste une requête mal formée, pas une panne
    // serveur — mais son détail technique ne part pas au client.
    return res.status(400).json({
      message: "L'envoi de l'image a échoué : la requête est mal formée.",
    })
  })
}

export default defineMiddlewares({
  routes: [
    {
      // L'écran de connexion et la déconnexion sont les DEUX seuls chemins du
      // back-office atteignables sans session — sans quoi personne ne pourrait
      // jamais s'y connecter. `allowUnauthenticated` est donc indispensable
      // ici : `allowUnregistered` seul ne couvre que le cas d'une identité
      // déjà authentifiée mais pas encore rattachée, et un visiteur sans
      // aucun jeton recevrait `{"message":"Unauthorized"}` au lieu du
      // formulaire.
      //
      // La règle ne fait rien d'autre que peupler `auth_context` quand une
      // session existe ; c'est le POST de connexion qui décide qui entre.
      //
      // Le drapeau `i` : ce n'est PAS une protection contre une boucle de
      // redirection, contrairement à ce qui était écrit ici. La règle
      // générale ci-dessous porte elle aussi le drapeau `i`, donc sa
      // lookahead négative `(?!connexion\/?$|deconnexion\/?$)` s'applique
      // aussi à `/Marchand/connexion` et le motif entier échoue : sans `i`
      // ici, ce chemin ne matcherait AUCUNE des deux règles et atteindrait
      // directement la route Express (dont le matcher, lui, est insensible à
      // la casse). L'écran resterait servi — pas de boucle — mais par un
      // chemin qui n'a traversé aucun intergiciel, donc sans `auth_context`
      // peuplé. Le drapeau reste la bonne hygiène : les deux règles jumelles
      // doivent partager exactement la même sensibilité à la casse, sous
      // peine de laisser un interstice entre elles.
      matcher: /^\/marchand\/(connexion|deconnexion)\/?$/i,
      middlewares: [
        authenticate("merchant", ["session", "bearer"], {
          allowUnregistered: true,
          allowUnauthenticated: true,
        }),
      ],
    },
    {
      // Toutes les autres PAGES du back-office. `authentifierPageMarchand`
      // (voir ./marchand/garde.ts) y porte TOUT le contrôle d'accès :
      // l'authentification du framework, puis `marchandActifOuRefus`. Un
      // refus sort en redirection vers l'écran de connexion, jamais en 401
      // JSON — une commerçante ne doit pas se retrouver devant
      // `{"message":"Unauthorized"}`.
      //
      // La règle refuse AVANT le routage : une page ajoutée plus tard sous
      // /marchand/* naît donc fermée sans que son auteur ait quoi que ce soit
      // à appeler — elle reçoit le marchand déjà résolu sur `req.marchand`
      // (type `RequetePageMarchand`). C'est ce que vérifient deux cas de
      // integration-tests/http/back-office-acces.spec.ts, qui exigent un 302
      // — et non un 404 — sur un chemin sans gestionnaire.
      //
      // Le drapeau `i` est indispensable : un matcher `RegExp` est utilisé tel
      // quel par Express (contrairement à un matcher chaîne, qu'Express
      // compile insensible à la casse par défaut). Sans lui, `/Marchand/...`
      // ne matcherait aucune règle mais atteindrait quand même la route
      // Express réelle — le contournement d'authentification exact déjà livré
      // une fois sur /merchant.
      matcher: /^\/marchand(?:\/(?!connexion\/?$|deconnexion\/?$).*)?$/i,
      middlewares: [authentifierPageMarchand],
    },
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
    {
      // Règle à méthode explicite : le trieur de routes l'exécute après la
      // règle générale ci-dessus (sans `methods`), qui rejoint donc
      // toujours l'authentification avant que multer ne parse le corps
      // multipart — un envoi non authentifié n'atteint jamais cette étape.
      matcher: "/merchant/catalogues",
      methods: ["POST"],
      middlewares: [televerserImage],
    },
  ],
})
