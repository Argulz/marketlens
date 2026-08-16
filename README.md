# MarketLens

Digitalisation visuelle du commerce informel africain.

Migration en cours vers Medusa v2 — voir
`docs/superpowers/specs/2026-08-16-marketlens-medusa-socle-design.md`.

## Services

| Service | Port | État |
|---|---|---|
| `services/vision` | 8001 | Opérationnel |
| `marketlens-commerce` (Medusa) | 9000 | Plan 2 |
| `marketlens-web` (Next.js) | 8000 | Plan 4 |

## Démarrer le service de vision

    cd services/vision
    python -m venv .venv
    .venv/Scripts/python -m pip install -r requirements.txt
    cp .env.example .env        # puis renseigner GEMINI_API_KEY et VISION_SERVICE_SECRET
    .venv/Scripts/python -m uvicorn app.main:app --port 8001 --reload

Tests :

    cd services/vision && .venv/Scripts/python -m pytest tests/ -v

Les tests d'intégration qui appellent réellement Gemini sont marqués et
désélectionnés par défaut. Pour les lancer (consomme du quota) :

    cd services/vision && .venv/Scripts/python -m pytest tests/ -m gemini -v

## Contrat HTTP du service de vision

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
| 500 | Service mal configuré (`GEMINI_API_KEY` ou `VISION_SERVICE_SECRET` absent) | Non |
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
