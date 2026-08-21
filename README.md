# MarketLens

Digitalisation visuelle du commerce informel africain.

Migration vers Medusa v2 — voir
`docs/superpowers/specs/2026-08-16-marketlens-medusa-socle-design.md`.

## Services

| Service | Port | État |
|---|---|---|
| `services/vision` | 8010 | Opérationnel — 77 tests |
| `marketlens-commerce` (Medusa) | 9000 | Opérationnel — lots 1 à 3 fusionnés, 73 tests |
| `marketlens-web` (Next.js) | 8000 | Lot 4, non commencé |

> **Le port du service de vision est 8010 et non 8001.** Sur la machine de
> développement, 8001 à 8008 sont occupés par la pile d'un autre projet qui
> démarre avec Docker Desktop. Le port n'est lu que par
> `marketlens-commerce/.env` (`VISION_SERVICE_URL`) : les deux valeurs doivent
> concorder, sans quoi Medusa rendra un 503 sur toute analyse de photo.

## Démarrer la pile complète

Trois terminaux, dans cet ordre.

    # 1 — PostgreSQL (port 5440 ; 5432 à 5435 sont pris par une autre pile)
    docker compose up -d

    # 2 — service de vision
    cd services/vision && .venv/Scripts/python -m uvicorn app.main:app --port 8010

    # 3 — Medusa
    cd marketlens-commerce && npm run dev

## Ce qui est consultable une fois la pile démarrée

| Adresse | Quoi |
|---|---|
| `http://localhost:9000/demo` | Banc d'essai du parcours marchand, de l'inscription à la vitrine. Chaque bouton appelle la vraie API. |
| `http://localhost:9000/c/<handle>` | Vitrine publique d'un catalogue publié, consultable et partageable. |
| `http://localhost:9000/app` | Console opérateur native de Medusa. **Elle montre les données de tous les marchands sans cloisonnement** — réservée à l'équipe, à ne jamais exposer. |

Le banc d'essai et la vitrine ne sont pas le lot 4 : ils servent à montrer et à
éprouver le lot 3 sans passer par `curl`. L'interface marchande et la vitrine
définitive restent à construire.

## Démarrer le service de vision

    cd services/vision
    python -m venv .venv
    .venv/Scripts/python -m pip install -r requirements.txt
    cp .env.example .env        # puis renseigner GEMINI_API_KEY et VISION_SERVICE_SECRET
    .venv/Scripts/python -m uvicorn app.main:app --port 8010 --reload

Tests :

    cd services/vision && .venv/Scripts/python -m pytest tests/ -v

Les tests d'intégration qui appellent réellement Gemini sont marqués et
désélectionnés par défaut. Pour les lancer (consomme du quota) :

    cd services/vision && .venv/Scripts/python -m pytest tests/ -m gemini -v

## Contrat HTTP du service de vision

> **Après toute modification de `services/vision/.env`, redémarrez le service.**
> Les variables sont lues une seule fois à l'import, et `uvicorn --reload` ne
> surveille que les fichiers `.py` : une clé corrigée ne sera pas reprise tant
> que le processus n'a pas été relancé.

Service sans état, jamais exposé publiquement. Toutes les routes sauf
`/health` exigent l'en-tête `X-Vision-Secret` (secret partagé avec Medusa).
Schéma faisant foi : `GET /openapi.json`.

### `GET /health`

Ouvert, sans secret. Rend `{"status": "ok", "service": "marketlens-vision"}`.

| Code | Quand |
|---|---|
| 200 | Toujours, si le processus répond |

### `POST /detect`

`multipart/form-data` : `image` (fichier, JPEG/PNG/WebP).
Rend `DetectResponse` : `{"products": [ProductOut], "count": int}`, avec
`ProductOut = {label, x, y, width, height, category}`. Coordonnées
normalisées **0–1000**, origine en haut à gauche, `x`/`y` au centre du
produit. `category` appartient aux sept catégories autorisées
(`fruits_legumes`, `viande_poisson`, `cereales`, `boissons`, `textile`,
`electronique`, `autre`), défaut `autre`.

**Échéance globale : 45s par défaut.** La requête entière — boucle de
réessai Gemini comprise — est bornée par `VISION_DEADLINE_S`, et non plus
seulement chaque tentative individuellement. Un appelant (nginx, load
balancer) doit caler son propre timeout **au-dessus** de cette valeur,
sans quoi il coupe la connexion avant le service et celui-ci continue de
consommer du quota Gemini pour une réponse que plus personne ne lira.

Trois variables d'environnement contrôlent ce budget (défauts entre
parenthèses) :

| Variable | Rôle | Défaut |
|---|---|---|
| `VISION_DEADLINE_S` | Échéance globale de la requête (secondes) | `45` |
| `VISION_TIMEOUT_MS` | Timeout par tentative Gemini (millisecondes) | `20000` |
| `VISION_MAX_RETRIES` | Nombre de tentatives Gemini | `3` |

| Code | Quand | Réessayer ? |
|---|---|---|
| 200 | Détection réussie (`count` peut valoir 0) | — |
| 400 | Image vide, ou format non reconnu (HEIC, fichier tronqué) | Non |
| 401 | `X-Vision-Secret` absent ou invalide | Non |
| 413 | Image au-delà de `MAX_IMAGE_BYTES` (20 Mo par défaut) | Non |
| 422 | Champ `image` absent du multipart (validation FastAPI) | Non |
| 429 | Quota Gemini dépassé en amont | Oui, plus tard |
| 500 | Service mal configuré : `GEMINI_API_KEY` ou `VISION_SERVICE_SECRET` absent, ou clé/modèle **refusés par Gemini** (400, 403, 404) | Non |
| 502 | Échec Gemini après réessais, ou réponse inexploitable | Oui |
| 504 | Échéance globale (`VISION_DEADLINE_S`) dépassée avant une réponse exploitable | Oui |

Le 502 reste réservé aux échecs amont explicites (Gemini a répondu une
erreur, ou une réponse inexploitable, après épuisement des tentatives) ;
le 504 signale que Gemini n'a simplement pas répondu à temps. Les deux
appellent des conduites différentes côté Medusa.

### `POST /annotate`

`multipart/form-data` : `image` (fichier) et `products` (chaîne JSON).
`products` doit être une **liste d'objets** portant au moins `x`, `y`,
`width`, `height` (numériques, échelle 0–1000) ; `label`, `category` et
`price` sont facultatifs. Rend l'image annotée en **`image/jpeg`**,
redimensionnée à 1200 px de large au maximum, ratio conservé.

| Code | Quand | Réessayer ? |
|---|---|---|
| 200 | Image annotée, corps `image/jpeg` | — |
| 400 | JSON invalide, `products` non-liste, élément non-objet, produit sans coordonnées, image illisible ou HEIC | Non |
| 401 | `X-Vision-Secret` absent ou invalide | Non |
| 413 | Image au-delà de `MAX_IMAGE_BYTES` | Non |
| 422 | Champ `image` ou `products` absent du multipart (validation FastAPI) | Non |
| 500 | `VISION_SERVICE_SECRET` non configuré | Non |

**Règle d'appel :** seuls 429 et 502 méritent un réessai. Un 4xx ne
deviendra jamais un 200 en réessayant la même requête.
