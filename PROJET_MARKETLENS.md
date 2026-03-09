# MarketLens — Digitalisation Visuelle du Commerce Informel Africain

Application web qui transforme une photo de marchandises en catalogue interactif et transactable, connecté à Mojaloop pour le paiement mobile money.

## Proposed Changes

### Backend (FastAPI + Python)

#### [NEW] [app.py](file:///c:/Projects/mojaloop/marketlens/backend/app.py)
Serveur FastAPI principal avec 3 routes :
- `POST /api/detect` — Reçoit une image, appelle Gemini Vision, retourne les produits détectés avec coordonnées
- `POST /api/annotate` — Reçoit image + produits (avec prix), génère l'image annotée JPEG
- `POST /api/pay` — Initie un paiement Mojaloop (transfert P2P)
- Sert le frontend statique depuis `/static`

#### [NEW] [gemini_vision.py](file:///c:/Projects/mojaloop/marketlens/backend/gemini_vision.py)
Module d'intégration Gemini avec le modèle `gemini-3-flash-preview` :
- Envoi de l'image avec prompt structuré
- Parsing de la réponse JSON (label, x, y, width, height, category)
- Gestion erreurs et retry

#### [NEW] [image_annotator.py](file:///c:/Projects/mojaloop/marketlens/backend/image_annotator.py)
Module de traitement d'image avec Pillow :
- Superposition d'étiquettes de prix aux coordonnées Gemini
- Badges colorés, coins arrondis, style professionnel
- Export JPEG optimisé pour partage WhatsApp

#### [NEW] [mojaloop_client.py](file:///c:/Projects/mojaloop/marketlens/backend/mojaloop_client.py)
Client Mojaloop simplifié :
- Lookup participant (GET /parties)
- Initiation de transfert (POST /transfers)
- Configuration via `.env`

#### [NEW] [requirements.txt](file:///c:/Projects/mojaloop/marketlens/backend/requirements.txt)
Dépendances : `fastapi`, `uvicorn`, `python-multipart`, `Pillow`, `google-genai`, `httpx`, `python-dotenv`

#### [NEW] [.env.example](file:///c:/Projects/mojaloop/marketlens/backend/.env.example)
Template des variables d'environnement (clé Gemini, URL Mojaloop)

---

### Frontend (PWA Mobile-First)

#### [NEW] [index.html](file:///c:/Projects/mojaloop/marketlens/frontend/index.html)
Page principale SPA avec 3 vues :
1. **Capture** — Bouton photo / upload image
2. **Édition** — Formulaire de saisie des prix (pré-rempli par Gemini)
3. **Catalogue** — Image interactive avec zones cliquables + panier

#### [NEW] [css/style.css](file:///c:/Projects/mojaloop/marketlens/frontend/css/style.css)
Design premium mobile-first : dark mode, glassmorphism, micro-animations, palette afro-moderne

#### [NEW] [js/app.js](file:///c:/Projects/mojaloop/marketlens/frontend/js/app.js)
Logique principale : navigation entre vues, upload image, appels API

#### [NEW] [js/catalogue.js](file:///c:/Projects/mojaloop/marketlens/frontend/js/catalogue.js)
Génération du catalogue interactif :
- Positionnement `absolute` des zones cliquables aux coordonnées Gemini
- Étiquettes de prix animées
- Gestion du panier et total

---

## Verification Plan

### Test semi-automatisé via navigateur
1. Lancer le serveur : `cd c:\Projects\mojaloop\marketlens\backend && python -m uvicorn app:app --reload --port 8000`
2. Ouvrir `http://localhost:8000` dans le navigateur
3. Uploader une image de produits de marché
4. Vérifier que les produits sont détectés et affichés dans le formulaire
5. Saisir des prix, cliquer "Générer catalogue"
6. Vérifier que l'image annotée s'affiche avec les prix aux bonnes positions
7. Vérifier que les zones sont cliquables et que le panier fonctionne

### Test API direct
- `curl -X POST http://localhost:8000/api/detect -F "image=@test_market.jpg"` — doit retourner un JSON avec les produits détectés et leurs coordonnées
