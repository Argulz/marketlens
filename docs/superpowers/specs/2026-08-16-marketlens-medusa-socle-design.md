# MarketLens sur Medusa — Lot 1 : socle commerce et catalogue visuel

**Date :** 2026-08-16
**Statut :** conception validée, prête pour le plan d'implémentation
**Périmètre :** lot 1 sur 4

## Contexte

MarketLens transforme la photo d'un étal de marché en catalogue de vente interactif : Gemini détecte les produits, Pillow incruste les prix, le client clique sur l'image pour commander, WhatsApp relie vendeur et acheteur.

Le prototype actuel est un FastAPI qui stocke ses catalogues sur le système de fichiers. Il fonctionne, mais trois limites bloquent le passage à un produit réel utilisé par de vrais marchands :

- **Aucune persistance structurée.** Un `metadata.json` par catalogue, ni produits, ni stock, ni commandes, ni clients.
- **Aucun paiement.** `MojaloopClient.initiate_transfer()` ne fait aucun appel réseau et retourne toujours `COMPLETED_DEMO`. Les factures PDF et les notifications WhatsApp sont émises sur un paiement fictif.
- **Aucune notion de marchand.** Le numéro du vendeur est un champ de formulaire recopié dans un fichier.

Ce lot remplace ces fondations par Medusa v2, sans changer ce que voit l'utilisateur.

## Décisions structurantes

Ces décisions ont été arrêtées en amont de la conception ; elles ne sont pas rouvertes dans ce document.

| Décision | Choix | Motif |
|---|---|---|
| Horizon | Produit réel, marchands réels | Justifie l'investissement Medusa |
| Modèle | SaaS mono-marchand : chaque vendeur sa boutique isolée | Pas de panier croisé, pas de paiement éclaté, pas de commission à répartir |
| Rail de paiement | Agrégateur mobile money direct (Kkiapay / FedaPay / MTN MoMo) | Mojaloop est un switch d'interopérabilité entre institutions, pas une API où une startup se branche. Il redevient une option future derrière l'abstraction Payment Provider. |
| Architecture | Medusa au cœur, FastAPI réduit à un service de vision sans état | La détection Gemini et l'annotation Pillow sont le différenciateur et fonctionnent déjà ; les réécrire en TypeScript serait du risque sans valeur |
| Environnement | Local uniquement | Aucun déploiement dans ce lot |

## Périmètre

**Dans le lot 1**

- Medusa v2 opérationnel en local avec PostgreSQL
- Module `merchant` et isolation multi-tenant vérifiée par des tests
- Module `visual-catalog` reliant photo, zones et produits Medusa
- Service de vision Python extrait, sans état, testé isolément
- Workflows d'analyse et de publication d'un catalogue
- Back-office marchand minimal et vitrine client
- Commande complète de bout en bout via le *manual payment provider* de Medusa
- Import du corpus des 28 catalogues existants comme jeu de données de test

**Hors du lot 1**

Paiement mobile money réel (lot 2), notifications WhatsApp (lot 3), inventaire par re-photographie (lot 4), mode hors-ligne, déploiement VPS.

## Architecture

Trois processus locaux, une seule dépendance d'infrastructure.

| Service | Techno | Port | Rôle |
|---|---|---|---|
| `marketlens-commerce` | Medusa v2, Node 20+ | 9000 | Système de référence : marchands, produits, stock, paniers, commandes, fichiers |
| `marketlens-vision` | FastAPI, Python | 8001 | Détection Gemini et annotation Pillow. Sans état. |
| `marketlens-web` | Next.js App Router | 8000 | Vitrine client et back-office marchand |

PostgreSQL via `docker-compose.yml`. **Redis n'est pas requis** : en développement, Medusa v2 utilise un event bus et un moteur de workflows en mémoire. Redis et un stockage S3 s'ajouteront au déploiement par configuration de modules, sans changement de code.

La version exacte de Medusa v2 est figée au moment de l'initialisation et pinnée dans `package.json` ; la surface d'API du framework évolue encore rapidement.

**Sens des dépendances :** `web → commerce → vision`. Jamais l'inverse. Le service de vision ne rappelle personne et n'a connaissance ni des marchands, ni des paniers, ni de l'argent.

### Frontière du service de vision

Deux routes, aucun état, aucune base de données :

- `POST /detect` — corps : bytes d'image. Réponse : `{ products: [{ label, x, y, width, height, category }] }`, coordonnées normalisées 0–1000.
- `POST /annotate` — corps : bytes d'image + liste de produits avec prix. Réponse : JPEG annoté.

Le service n'est pas exposé publiquement. Seul Medusa l'appelle, sur `http://localhost:8001`, authentifié par un secret partagé lu depuis l'environnement (`VISION_SERVICE_SECRET`). En déploiement, seule l'URL changera.

Le code conservé de l'existant est `backend/gemini_vision.py` et `backend/image_annotator.py`, à peu près inchangés. Le reste — `app.py`, `catalogue_store.py`, `mojaloop_client.py`, `whatsapp_client.py`, `receipt_generator.py` — est supprimé au profit des mécanismes Medusa équivalents.

## Multi-tenance marchand

C'est la partie la plus exigeante du lot. Medusa n'est pas nativement multi-tenant ; l'isolation se construit sur trois mécanismes du framework, chacun couvrant une facette.

### Module `merchant`

Entité `Merchant` : `id`, `name`, `handle` (identifiant lisible unique, réservé à une future page boutique — non utilisé dans les URLs du lot 1 ; normalisé en slug minuscule `^[a-z0-9]+(-[a-z0-9]+)*$` à l'inscription, parce que l'index unique de Postgres est sensible à la casse et que deux handles ne différant que par la casse se disputeraient la même URL publique), `phone`, `whatsapp_phone`, `currency_code` (`xof`, **en minuscules**, par défaut — c'est la valeur réellement stockée par le modèle et assertée par les tests ; la forme majuscule `XOF` n'apparaît nulle part dans le code), `status`. Entité pivot du système.

### Les trois mécanismes d'isolation

**Sales Channel — un par marchand.** Les produits y sont rattachés, et une clé API publiable propre au marchand filtre la Store API.

La portée exacte de ce filtrage, vérifiée par sonde réelle et verrouillée par un test (`integration-tests/http/merchant-isolation.spec.ts`) :

- **Filtrés par le framework, sans code applicatif : les produits et les paniers.** La vitrine d'un marchand ne peut structurellement pas retourner les produits d'un autre. Sur ce périmètre, c'est l'isolation la plus solide des trois.
- **Globaux à l'instance, donc NON filtrés : les collections, les catégories de produits, les régions, les tags et les types de produits.** `/store/collections` et `/store/product-categories` renvoient à la clé publiable d'un marchand les collections et catégories créées par n'importe quel autre. Ce n'est pas une nuance : c'est une fuite dès qu'on s'en sert pour regrouper.

Aucune fuite vive dans le lot 1 — rien n'y crée de collection ni de catégorie par marchand. Mais le lot 3 construit le catalogue visuel, et regrouper les produits d'un marchand par collection ou catégorie est le premier réflexe. **Tout regroupement par marchand doit reposer sur un filtrage applicatif explicite (par exemple par `sales_channel_id` ou par le lien `merchant`), jamais sur la seule clé publiable.**

**Stock Location — une par marchand.** Les niveaux du module *Inventory* sont attachés à un emplacement, donc naturellement cloisonnés. C'est aussi ce qui rendra le lot 4 réalisable.

**Acteur d'authentification custom.** Medusa v2 permet de déclarer un type d'acteur autre que `admin` et `customer`. On déclare `merchant` ; les routes `/merchant/*` sont protégées par `authenticate("merchant", ["session", "bearer"])`. L'identité d'authentification porte le `merchant_id` dans ses `app_metadata`, et un middleware l'injecte dans la requête pour filtrer toute lecture et écriture.

### Ce qu'on n'utilise pas

**L'admin Medusa natif n'est pas exposé aux marchands.** Il n'est pas cloisonnable — un marchand y verrait les données de tous les autres. Il reste disponible pour l'opérateur de la plateforme, à des fins de supervision.

Le back-office marchand est donc à construire dans `marketlens-web`, sur les routes `/merchant/*`. **C'est le principal poste de travail du lot et le coût d'entrée assumé de Medusa sur un usage SaaS.**

### Provisionnement d'un marchand

La création d'un marchand est un workflow atomique qui enchaîne : création du `Merchant`, du sales channel, de la stock location, de la clé publiable, des liens entre eux, et de l'identité d'authentification. Chaque étape porte sa compensation ; un marchand à moitié provisionné est un état interdit.

**Sémantique de `status`.** Trois valeurs : `pending`, `active`, `suspended`.

- `pending` est la valeur par défaut du modèle. Elle ne décrit qu'un marchand créé hors du workflow de provisionnement (import, script d'opérateur) : ses ressources de cloisonnement ne sont pas garanties.
- `active` est posée explicitement par le workflow de provisionnement, à la création de l'enregistrement. Un marchand qui sort du workflow est immédiatement opérationnel : il n'y a pas d'étape de validation dans le lot 1.
- `suspended` est posée par l'opérateur de la plateforme.

`status` n'est pas décoratif : **toute route marchand refuse un marchand dont le statut n'est pas `active`** (403, message français). Sans cette lecture, une suspension n'aurait aucun effet observable — le marchand suspendu continuerait d'être servi normalement.

## Module `visual-catalog`

### Entités

`VisualCatalogue` : `id`, `handle` (identifiant court et unique du catalogue, c'est lui qui apparaît dans l'URL de partage `/c/[handle]`), `title`, `source_image_url`, `annotated_image_url`, `status` (`draft` | `published`).

`CatalogueZone` : `id`, `catalogue_id`, `x`, `y`, `width`, `height` (normalisés 0–1000), `detected_label`, `detected_category`.

### Liens de modules

Les rattachements inter-modules passent par `defineLink`, jamais par clé étrangère — Medusa v2 l'impose :

- `Merchant → VisualCatalogue`
- `CatalogueZone → Product`

Une zone pointe vers un **produit**, pas vers une variante : une zone représente « ce tas de tomates » ou « ces jeans », les variantes sont les choix à l'intérieur.

### Principe de conception central

**Le prix, les variantes et le stock n'appartiennent pas au catalogue visuel.**

Le `metadata.json` actuel porte `price`, `colors` et `sizes` ; tout cela migre vers les entités Medusa. La zone ne conserve que sa géométrie, son label détecté et son lien vers le produit.

Cette séparation est ce qui rend le lot 4 possible : quand le stock changera, la vitrine le reflétera sans qu'on retouche le catalogue visuel.

> **Correctif au principe ci-dessus, apporté après la revue du lot 3.** La séparation
> est réelle pour les **variantes** et le **stock**. Elle est **fausse pour le prix**,
> et le principe tel qu'énoncé était donc inexact sur un de ses trois termes.
>
> `annotated_image_url` est une image dans laquelle le service de vision **grave les
> prix** : l'étape d'annotation reçoit un `price` par produit. Le catalogue visuel
> porte donc bien de l'information de prix — sous forme de pixels, dans un champ qui
> lui appartient. Conséquence concrète : toute modification de prix dans Medusa
> désynchronise silencieusement l'image que l'acheteur voit de la vérité du système,
> et rien dans le code ne détecte ni ne signale cette dérive. Aucun chemin de
> ré-annotation n'existe, l'étape d'annotation n'étant appelable que depuis la
> publication, elle-même verrouillée après la première fois.
>
> Ce n'est pas un défaut d'implémentation — le lot 3 a suivi ce document. C'est un
> défaut de ce document, qui énonçait une séparation à trois termes alors que son
> propre artefact central en re-capture un.
>
> **À trancher avant le lot suivant**, qui offrira au marchand un écran d'édition des
> prix : soit l'édition post-publication déclenche une ré-annotation (et il faut donc
> conserver la clé du fichier source), soit le prix sort de l'image et passe en
> surimpression HTML côté vitrine. La seconde voie est la solution architecturalement
> propre : c'est la seule qui rendrait ce principe de conception réellement vrai.

### Traitement des variantes

Les couleurs et tailles saisies par le marchand deviennent des `ProductOption` (« Couleur », « Taille ») et leur produit cartésien des `ProductVariant`, chacune avec son prix et son niveau de stock.

Aujourd'hui, couleur et taille voyagent en texte libre dans le panier et sur la facture. Demain, « il reste des rouges en L, plus en M » devient une vérité du système.

Si le marchand ne définit aucune variante, un produit à variante unique est créé — Medusa l'exige de toute façon, et aucune complexité n'est ajoutée.

## Workflows

Deux workflows distincts. **La détection ne crée aucune donnée commerciale.**

### `analyzeCataloguePhoto`

1. Dépôt de l'image source via le module *File* — compensation : suppression
2. Appel `vision/detect` — lecture pure, pas de compensation, avec réessais
3. Création d'un `VisualCatalogue` en statut `draft` et de ses `CatalogueZone`

Aucun produit n'existe à l'issue de ce workflow. Le marchand reçoit un brouillon qu'il corrige dans son back-office : noms, descriptions, prix, couleurs, tailles, quantités. Une détection ratée ne coûte rien et s'annule sans laisser de trace.

### `publishCatalogue`

Prend le brouillon corrigé. C'est la transaction qui crée de la valeur :

1. Création des produits via `createProductsWorkflow`, avec options, variantes, prix en `xof` (code devise en minuscules), rattachés au sales channel du marchand
2. Création des niveaux d'inventaire à la stock location du marchand
3. Liaison de chaque `CatalogueZone` à son produit
4. Appel `vision/annotate` pour produire l'image annotée
5. Dépôt de l'image annotée via le module *File*
6. Passage du catalogue en `published`

Chaque étape porte sa compensation. L'échec de l'étape 4 ne doit laisser aucun produit orphelin — c'est explicitement testé.

## Vitrine et back-office

### Vitrine client — `/c/[handle]`

Visuellement identique à l'existant : image annotée, zones cliquables positionnées en pourcentage, sélecteurs de variantes, panier.

Trois différences invisibles mais réelles :

- Le panier est un vrai *Cart* Medusa, persisté, qui survit au rafraîchissement de la page (aujourd'hui il vit en mémoire JavaScript et disparaît).
- La page est rendue côté serveur avec des balises Open Graph pointant l'image annotée. Le lien de partage étant destiné à WhatsApp, il affiche un aperçu riche au lieu d'une URL nue — sur ce canal, le lien *est* le produit.
- Les appels Store API portent la clé publiable du marchand, ce qui garantit l'isolation au niveau du framework.

La feuille de style existante (`frontend/css/style.css`, 1288 lignes) est reprise ; l'identité visuelle est conservée intégralement.

### Back-office marchand — `/app`

Authentification par acteur `merchant`. Écrans minimaux mais complets pour le parcours :

- Envoi d'une photo, suivi de l'analyse
- Édition du brouillon : nom, description, prix, couleurs, tailles, quantité par produit détecté
- Publication et récupération du lien de partage
- Liste des catalogues publiés
- Liste des commandes reçues

### Paiement dans ce lot

Le *manual payment provider* fourni par Medusa est activé. La commande se conclut réellement, de bout en bout, en local.

Ce n'est pas un faux succès comme le `COMPLETED_DEMO` actuel : c'est un mode de paiement légitime, placé au bon endroit architectural, que le lot 2 remplacera par l'agrégateur sans toucher au reste du système.

## Données existantes

Les 28 catalogues de `backend/catalogues/` sont des données de développement, pas de production. Ils ne sont pas migrés comme un patrimoine à préserver.

Ils constituent en revanche le meilleur corpus de test disponible : vraies photos d'étals, vraies détections Gemini, vrais prix et vraies variantes. Un script `seed:legacy` les importe dans la base locale — marchands dédupliqués par numéro de téléphone, catalogues, zones, produits, variantes.

**Sa valeur n'est pas de sauver des données : c'est de prouver que le nouveau modèle sait représenter tout ce que l'ancien représentait.** Un catalogue qui ne passe pas révèle un trou dans le modèle.

### Correction nécessaire

`backend/catalogues/` et `backend/receipts/` sortent du dépôt (`git rm --cached`, ajout au `.gitignore`), et sont archivés localement hors de l'arborescence git. Des numéros de téléphone réels et des factures nominatives n'ont rien à faire dans l'historique d'un dépôt.

## Stratégie de test

### `marketlens-vision`

Le service le plus testable — argument supplémentaire en faveur de la frontière choisie.

- Parsing et validation (`_parse_json_response`, `_validate_products`) testés sur des réponses Gemini enregistrées en fixtures.
- Annotation testée **par propriétés** — format JPEG, dimensions de sortie, badges contenus dans les bornes de l'image — et jamais par comparaison pixel à pixel, qui serait fragile et sans valeur.
- Quelques tests d'intégration réels contre Gemini existent, marqués et exclus de la suite par défaut : lents, coûteux, non déterministes.

### `marketlens-commerce`

Sur `moduleIntegrationTestRunner` et `medusaIntegrationTestRunner` fournis par Medusa.

- **Tests de service** pour `merchant` et `visual-catalog`.
- **Tests de workflow**, avec le service de vision doublé par un stub HTTP. C'est ici que la frontière propre se rembourse.
- **Test d'isolation multi-tenant.** Deux marchands provisionnés ; vérification qu'aucune route `/merchant/*` et aucune requête Store API portant la clé publiable de l'un ne laisse fuir quoi que ce soit de l'autre. Concrètement, il doit assert : les trois ressources de cloisonnement distinctes (canal de vente, emplacement de stock, clé API) ; **la clé publiable de chaque marchand liée à exactement un canal** — c'est cette assertion, et elle seule, qui attrape une rupture asymétrique où la clé de l'un serait liée à un sur-ensemble de canaux ; la non-visibilité des produits **dans les deux sens**, un produit créé de chaque côté ; et la limite connue sur les collections et catégories. *S'il n'existe qu'un test à ne jamais laisser casser, c'est celui-là.*
- **Test de compensation.** Faire échouer `vision/annotate` au milieu de `publishCatalogue` et vérifier qu'aucun produit orphelin ne subsiste.

### `marketlens-web`

Un test de bout en bout sous Playwright, en local, vision stubé : photo → brouillon → publication → vitrine → panier → commande.

## Ordre d'implémentation

L'ordre est contraint par les dépendances :

1. Extraction et tests du service de vision
2. Socle Medusa : projet, PostgreSQL, configuration des modules
3. Module `merchant`, acteur d'authentification, workflow de provisionnement, **tests d'isolation**
4. Module `visual-catalog` et liens de modules
5. Workflows `analyzeCataloguePhoto` et `publishCatalogue`
6. Back-office marchand
7. Vitrine client
8. Script `seed:legacy` et validation du modèle sur le corpus

## Risques et points de vigilance

**La multi-tenance est le risque principal.** Medusa n'y est pas conçu nativement. L'isolation par sales channel est solide car appliquée par le framework, mais l'isolation des routes `/merchant/*` repose sur du code applicatif — un middleware oublié sur une route est une fuite de données entre marchands. D'où le statut particulier du test d'isolation.

**Limites acceptées du lot 1**, constatées et assumées plutôt que corrigées :

- **Les collections, catégories, régions, tags et types de produits ne sont pas cloisonnés** par la clé publiable (voir « Les trois mécanismes d'isolation »). Un test nommé `LIMITE CONNUE` la constate explicitement : si Medusa portait un jour ces ressources sur le canal de vente, ce test deviendrait rouge et signalerait qu'on peut relâcher la contrainte.
- **Le refus d'une requête Store API sans clé publiable rend un message en anglais** (`Publishable API key required in the request header: x-publishable-api-key…`, HTTP 400, `MedusaError.Types.NOT_ALLOWED` — `node_modules/@medusajs/framework/dist/http/middlewares/ensure-publishable-api-key.js:8`). Ce message vient d'un middleware du framework, sur une route qu'aucun code de ce dépôt ne possède ; le franciser supposerait de réécrire une route Store de Medusa. Contrainte « messages en français » volontairement non appliquée ici : elle ne vaut que pour les routes écrites dans ce dépôt.

**La surface d'API de Medusa v2 évolue encore.** Version pinnée, montées de version traitées comme des changements explicites.

**Le back-office marchand est le poste de travail le plus lourd** et le plus facile à sous-estimer, puisqu'il remplace un admin qu'on aurait pu croire gratuit.

**Gemini reste non déterministe.** Le modèle `gemini-3-flash-preview` est un aperçu ; le nom du modèle doit être configurable, pas codé en dur comme aujourd'hui.

## Lots suivants

| Lot | Contenu | Dépend de |
|---|---|---|
| 2 | Payment Provider mobile money, webhooks de confirmation, facture PDF | Lot 1 |
| 3 | Notification Provider WhatsApp sur événements Medusa | Lot 1 |
| 4 | Inventaire par re-photographie : diff Gemini contre catalogue, ajustement des niveaux de stock | Lot 1 |

Les lots 2 et 3 sont indépendants entre eux. Les deux exigeront un tunnel local pour recevoir les webhooks entrants ; le lot 1 n'en a pas besoin.
