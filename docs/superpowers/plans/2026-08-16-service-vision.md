# Service de vision MarketLens — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extraire de l'actuel monolithe FastAPI un service de vision autonome et sans état, exposant un contrat HTTP figé que Medusa consommera.

**Architecture:** Un service FastAPI à deux routes utiles — `POST /detect` (Gemini) et `POST /annotate` (Pillow) — plus `/health`. Aucune base de données, aucune persistance, aucune connaissance des marchands, des paniers ni de l'argent. Protégé par un secret partagé, jamais exposé publiquement. La détection Gemini est injectée par dépendance FastAPI, ce qui la rend substituable en test sans toucher au réseau.

**Tech Stack:** Python 3.10+, FastAPI, Pillow, `google-genai`, pytest.

**Spec:** `docs/superpowers/specs/2026-08-16-marketlens-medusa-socle-design.md`

## Global Constraints

- Le service est **sans état** : ni base de données, ni écriture disque, ni cache persistant.
- Coordonnées produits **normalisées 0–1000** (`x`, `y` = centre ; `width`, `height` = dimensions).
- Catégories autorisées : `fruits_legumes`, `viande_poisson`, `cereales`, `boissons`, `textile`, `electronique`, `autre`.
- Le nom du modèle Gemini est **configurable par variable d'environnement**, jamais codé en dur.
- Toute route autre que `/health` exige l'en-tête `X-Vision-Secret`.
- Port de développement : **8001**.
- Aucun test de la suite par défaut ne doit appeler l'API Gemini réelle.
- Les tests d'annotation vérifient des **propriétés** (format, dimensions, bornes), jamais une comparaison pixel à pixel.
- Messages d'erreur destinés à l'utilisateur en français, comme le code existant.

## Structure de fichiers

```
services/vision/
├── requirements.txt          # dépendances du service seul
├── .env.example              # GEMINI_API_KEY, GEMINI_MODEL, VISION_SERVICE_SECRET
├── app/
│   ├── __init__.py
│   ├── config.py             # lecture de l'environnement, mise en cache
│   ├── auth.py               # dépendance de vérification du secret partagé
│   ├── detection.py          # ProductDetector + parsing/validation (ex-gemini_vision.py)
│   ├── annotation.py         # annotate_image (ex-image_annotator.py, inchangé)
│   └── main.py               # application FastAPI et routes
└── tests/
    ├── conftest.py           # fixtures partagées : environnement, client, images
    ├── fixtures/
    │   └── gemini_responses/ # réponses Gemini enregistrées
    ├── test_health.py
    ├── test_parsing.py
    ├── test_detect_route.py
    └── test_annotate_route.py
```

Chaque fichier porte une responsabilité unique. `detection.py` ne sait rien de HTTP ; `main.py` ne sait rien de Gemini au-delà du type qu'il injecte.

---

### Task 1 : Squelette du service et route de santé

**Files:**
- Create: `services/vision/requirements.txt`
- Create: `services/vision/.env.example`
- Create: `services/vision/app/__init__.py` (vide)
- Create: `services/vision/app/config.py`
- Create: `services/vision/app/main.py`
- Test: `services/vision/tests/conftest.py`, `services/vision/tests/test_health.py`

**Interfaces:**
- Consumes: rien
- Produces: `app.config.Settings` avec les attributs `gemini_api_key: str`, `gemini_model: str`, `service_secret: str`, `max_image_bytes: int` ; `app.config.get_settings() -> Settings` (mise en cache LRU, `get_settings.cache_clear()` disponible en test) ; `app.main.app` (instance FastAPI).

- [ ] **Step 1 : Créer l'environnement Python du service**

```bash
cd services/vision
python -m venv .venv
.venv/Scripts/python -m pip install --upgrade pip
```

Créer `services/vision/requirements.txt` :

```
fastapi==0.115.0
uvicorn[standard]==0.30.0
python-multipart==0.0.9
Pillow==10.4.0
google-genai==1.5.0
httpx>=0.28.1
python-dotenv==1.0.1
pytest==8.3.3
```

Puis :

```bash
.venv/Scripts/python -m pip install -r requirements.txt
```

- [ ] **Step 2 : Écrire le test de santé qui échoue**

`services/vision/tests/conftest.py` :

```python
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app


@pytest.fixture(autouse=True)
def environnement(monkeypatch):
    monkeypatch.setenv("VISION_SERVICE_SECRET", "secret-de-test")
    monkeypatch.setenv("GEMINI_API_KEY", "cle-de-test")
    monkeypatch.setenv("GEMINI_MODEL", "modele-de-test")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client():
    return TestClient(app)
```

`services/vision/tests/test_health.py` :

```python
def test_health_repond_ok(client):
    reponse = client.get("/health")
    assert reponse.status_code == 200
    assert reponse.json() == {"status": "ok", "service": "marketlens-vision"}


def test_health_ne_demande_pas_de_secret(client):
    assert client.get("/health").status_code == 200
```

- [ ] **Step 3 : Lancer le test pour vérifier qu'il échoue**

```bash
cd services/vision && .venv/Scripts/python -m pytest tests/test_health.py -v
```

Attendu : ÉCHEC à la collecte, `ModuleNotFoundError: No module named 'app.config'`.

- [ ] **Step 4 : Écrire l'implémentation minimale**

`services/vision/app/config.py` :

```python
import os
from functools import lru_cache


class Settings:
    def __init__(self) -> None:
        self.gemini_api_key = os.getenv("GEMINI_API_KEY", "")
        self.gemini_model = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")
        self.service_secret = os.getenv("VISION_SERVICE_SECRET", "")
        self.max_image_bytes = int(os.getenv("MAX_IMAGE_BYTES", 20 * 1024 * 1024))


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

`services/vision/app/main.py` :

```python
import os

from dotenv import load_dotenv
from fastapi import FastAPI

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

app = FastAPI(title="MarketLens Vision", version="1.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "marketlens-vision"}
```

`services/vision/app/__init__.py` : fichier vide.

`services/vision/.env.example` :

```
GEMINI_API_KEY=votre_cle_gemini
GEMINI_MODEL=gemini-3-flash-preview
VISION_SERVICE_SECRET=un_secret_partage_avec_medusa
MAX_IMAGE_BYTES=20971520
```

- [ ] **Step 5 : Lancer le test pour vérifier qu'il passe**

```bash
cd services/vision && .venv/Scripts/python -m pytest tests/test_health.py -v
```

Attendu : 2 tests PASSÉS.

- [ ] **Step 6 : Vérifier que le service démarre**

```bash
cd services/vision && .venv/Scripts/python -m uvicorn app.main:app --port 8001
```

Attendu : `Uvicorn running on http://127.0.0.1:8001`. Arrêter avec Ctrl+C.

- [ ] **Step 7 : Commit**

```bash
git add services/vision
git commit -m "feat(vision): squelette du service de vision et route de santé"
```

---

### Task 2 : Parsing et validation des réponses Gemini

Le code existant de `backend/gemini_vision.py` fonctionne mais n'est pas testé, et son parsing est la source la plus probable de pannes en production : Gemini renvoie du texte libre. On le déplace, on rend le modèle configurable, et on le couvre de tests.

**Files:**
- Create: `services/vision/app/detection.py` (depuis `backend/gemini_vision.py`)
- Create: `services/vision/tests/fixtures/gemini_responses/` (3 fichiers)
- Test: `services/vision/tests/test_parsing.py`

**Interfaces:**
- Consumes: rien
- Produces: `app.detection.parse_json_response(text: str) -> list` (lève `ValueError` si non exploitable) ; `app.detection.validate_products(products: list) -> list[dict]` (renvoie des dicts aux clés `label`, `x`, `y`, `width`, `height`, `category`) ; `app.detection.DETECTION_PROMPT: str`.

- [ ] **Step 1 : Enregistrer les réponses Gemini en fixtures**

`services/vision/tests/fixtures/gemini_responses/propre.json` :

```json
[{"label": "Tomates", "x": 250, "y": 400, "width": 200, "height": 150, "category": "fruits_legumes"}]
```

`services/vision/tests/fixtures/gemini_responses/avec_fence.txt` — Gemini entoure fréquemment sa réponse de délimiteurs markdown. Écrire ce fichier avec la commande suivante, pour éviter toute ambiguïté sur les caractères exacts :

```bash
printf '%s\n%s\n%s\n' \
  '```json' \
  '[{"label": "Bananes plantain", "x": 600, "y": 300, "width": 180, "height": 220, "category": "fruits_legumes"}]' \
  '```' \
  > services/vision/tests/fixtures/gemini_responses/avec_fence.txt
```

`services/vision/tests/fixtures/gemini_responses/refus.txt` :

```
Je ne peux pas analyser cette image car elle est floue.
```

- [ ] **Step 2 : Écrire les tests qui échouent**

`services/vision/tests/test_parsing.py` :

```python
from pathlib import Path

import pytest

from app.detection import parse_json_response, validate_products

FIXTURES = Path(__file__).parent / "fixtures" / "gemini_responses"


def lire(nom: str) -> str:
    return (FIXTURES / nom).read_text(encoding="utf-8")


def test_parse_json_nu():
    produits = parse_json_response(lire("propre.json"))
    assert produits[0]["label"] == "Tomates"


def test_parse_retire_les_delimiteurs_markdown():
    produits = parse_json_response(lire("avec_fence.txt"))
    assert produits[0]["label"] == "Bananes plantain"


def test_parse_accepte_un_objet_enveloppe():
    produits = parse_json_response('{"products": [{"label": "Riz"}]}')
    assert produits == [{"label": "Riz"}]


def test_parse_leve_une_erreur_sur_un_refus_en_texte_libre():
    with pytest.raises(ValueError):
        parse_json_response(lire("refus.txt"))


def test_validate_borne_les_coordonnees_hors_limites():
    (produit,) = validate_products(
        [{"label": "Tomates", "x": 1500, "y": -20, "width": 5, "height": 200}]
    )
    assert produit["x"] == 1000
    assert produit["y"] == 0
    assert produit["width"] == 20


def test_validate_applique_les_valeurs_par_defaut():
    (produit,) = validate_products([{}])
    assert produit["label"] == "Produit"
    assert produit["category"] == "autre"


def test_validate_ignore_les_entrees_inexploitables():
    produits = validate_products(
        [{"label": "Bon", "x": 10, "y": 10}, {"label": "Mauvais", "x": "abc"}]
    )
    assert [p["label"] for p in produits] == ["Bon"]
```

- [ ] **Step 3 : Lancer les tests pour vérifier qu'ils échouent**

```bash
cd services/vision && .venv/Scripts/python -m pytest tests/test_parsing.py -v
```

Attendu : ÉCHEC, `ModuleNotFoundError: No module named 'app.detection'`.

- [ ] **Step 4 : Déplacer et adapter le module de détection**

```bash
git mv backend/gemini_vision.py services/vision/app/detection.py
```

Dans `services/vision/app/detection.py`, renommer les deux fonctions privées en fonctions publiques et supprimer l'ancienne fonction `detect_products` (elle est remplacée en Task 3) :

```python
def parse_json_response(text: str) -> list:
    """Parse la réponse de Gemini, en gérant les blocs de code markdown."""
    cleaned = re.sub(r'```(?:json)?\s*', '', text).strip()

    try:
        result = json.loads(cleaned)
    except json.JSONDecodeError as e:
        logger.error(f"Erreur de parsing JSON: {e}\nTexte: {cleaned[:500]}")
        raise ValueError(f"Réponse Gemini non-JSON valide: {e}")

    if isinstance(result, list):
        return result
    if isinstance(result, dict) and "products" in result:
        return result["products"]
    return [result]


def validate_products(products: list) -> list[dict]:
    """Valide et normalise les produits détectés."""
    validated = []
    for p in products:
        try:
            validated.append({
                "label": str(p.get("label", "Produit")),
                "x": _clamp(int(p.get("x", 500)), 0, 1000),
                "y": _clamp(int(p.get("y", 500)), 0, 1000),
                "width": _clamp(int(p.get("width", 100)), 20, 1000),
                "height": _clamp(int(p.get("height", 100)), 20, 1000),
                "category": p.get("category", "autre"),
            })
        except (ValueError, TypeError, AttributeError) as e:
            logger.warning(f"Produit invalide ignoré: {p} — {e}")
    return validated
```

Conserver `DETECTION_PROMPT`, `_detect_mime_type` et `_clamp` tels quels. Supprimer les imports devenus inutiles (`base64`).

- [ ] **Step 5 : Lancer les tests pour vérifier qu'ils passent**

```bash
cd services/vision && .venv/Scripts/python -m pytest tests/test_parsing.py -v
```

Attendu : 7 tests PASSÉS.

- [ ] **Step 6 : Commit**

```bash
git add -A services/vision backend
git commit -m "feat(vision): déplace la détection Gemini et couvre son parsing de tests"
```

---

### Task 3 : Route `POST /detect` et secret partagé

**Files:**
- Create: `services/vision/app/auth.py`
- Modify: `services/vision/app/detection.py` (ajout de `ProductDetector`)
- Modify: `services/vision/app/main.py`
- Test: `services/vision/tests/test_detect_route.py`

**Interfaces:**
- Consumes: `app.detection.parse_json_response`, `app.detection.validate_products`, `app.detection.DETECTION_PROMPT`, `app.config.get_settings`
- Produces: `app.auth.require_service_secret` (dépendance FastAPI) ; `app.detection.ProductDetector(api_key: str, model: str)` avec `async def detect(self, image_bytes: bytes) -> list[dict]` ; `app.main.get_detector() -> ProductDetector` (point de substitution en test via `app.dependency_overrides`). Réponse de `POST /detect` : `{"products": [...], "count": int}`.

- [ ] **Step 1 : Écrire les tests qui échouent**

`services/vision/tests/test_detect_route.py` :

```python
import pytest

from app.main import app, get_detector

ENTETE = {"X-Vision-Secret": "secret-de-test"}
IMAGE = ("etal.jpg", b"\xff\xd8\xff\xe0 contenu factice", "image/jpeg")


class DetecteurFactice:
    def __init__(self, produits):
        self.produits = produits
        self.appels = []

    async def detect(self, image_bytes: bytes) -> list[dict]:
        self.appels.append(image_bytes)
        return self.produits


@pytest.fixture
def detecteur():
    faux = DetecteurFactice([
        {"label": "Tomates", "x": 250, "y": 400, "width": 200,
         "height": 150, "category": "fruits_legumes"}
    ])
    app.dependency_overrides[get_detector] = lambda: faux
    yield faux
    app.dependency_overrides.clear()


def test_refuse_sans_secret(client, detecteur):
    reponse = client.post("/detect", files={"image": IMAGE})
    assert reponse.status_code == 401


def test_refuse_avec_un_mauvais_secret(client, detecteur):
    reponse = client.post(
        "/detect", files={"image": IMAGE}, headers={"X-Vision-Secret": "faux"}
    )
    assert reponse.status_code == 401


def test_retourne_les_produits_detectes(client, detecteur):
    reponse = client.post("/detect", files={"image": IMAGE}, headers=ENTETE)
    assert reponse.status_code == 200
    corps = reponse.json()
    assert corps["count"] == 1
    assert corps["products"][0]["label"] == "Tomates"
    assert detecteur.appels == [IMAGE[1]]


def test_refuse_une_image_vide(client, detecteur):
    reponse = client.post(
        "/detect", files={"image": ("vide.jpg", b"", "image/jpeg")}, headers=ENTETE
    )
    assert reponse.status_code == 400


def test_refuse_une_image_trop_volumineuse(client, detecteur, monkeypatch):
    monkeypatch.setenv("MAX_IMAGE_BYTES", "10")
    from app.config import get_settings
    get_settings.cache_clear()

    reponse = client.post(
        "/detect",
        files={"image": ("grosse.jpg", b"x" * 100, "image/jpeg")},
        headers=ENTETE,
    )
    assert reponse.status_code == 413
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

```bash
cd services/vision && .venv/Scripts/python -m pytest tests/test_detect_route.py -v
```

Attendu : ÉCHEC, `ImportError: cannot import name 'get_detector' from 'app.main'`.

- [ ] **Step 3 : Écrire la dépendance d'authentification**

`services/vision/app/auth.py` :

```python
import hmac

from fastapi import Header, HTTPException

from app.config import get_settings


def require_service_secret(x_vision_secret: str = Header(default="")) -> None:
    """Vérifie le secret partagé entre Medusa et le service de vision."""
    attendu = get_settings().service_secret
    if not attendu:
        raise HTTPException(status_code=500, detail="VISION_SERVICE_SECRET non configuré")
    if not hmac.compare_digest(x_vision_secret, attendu):
        raise HTTPException(status_code=401, detail="Secret de service invalide")
```

`hmac.compare_digest` compare en temps constant : la durée de la réponse ne renseigne pas sur le préfixe correct du secret.

- [ ] **Step 4 : Écrire le détecteur**

Ajouter à `services/vision/app/detection.py` :

```python
class ProductDetector:
    """Encapsule l'appel à Gemini. Substituable en test."""

    MAX_RETRIES = 3

    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    async def detect(self, image_bytes: bytes) -> list[dict]:
        if not self.api_key:
            raise RuntimeError("GEMINI_API_KEY non configurée")

        client = genai.Client(api_key=self.api_key)
        mime_type = _detect_mime_type(image_bytes)
        logger.info(f"Envoi à Gemini ({len(image_bytes)} octets, {mime_type}, {self.model})")

        derniere_erreur: Exception | None = None
        for tentative in range(self.MAX_RETRIES):
            try:
                response = client.models.generate_content(
                    model=self.model,
                    contents=[
                        types.Content(parts=[
                            types.Part(inline_data=types.Blob(
                                mime_type=mime_type, data=image_bytes)),
                            types.Part(text=DETECTION_PROMPT),
                        ])
                    ],
                    config=types.GenerateContentConfig(
                        temperature=0.1, max_output_tokens=4096),
                )
                produits = parse_json_response(response.text.strip())
                valides = validate_products(produits)
                logger.info(f"Produits détectés: {len(valides)}")
                return valides
            except Exception as e:
                derniere_erreur = e
                logger.warning(f"Tentative {tentative + 1}/{self.MAX_RETRIES} échouée: {e}")

        raise RuntimeError(
            f"Échec de la détection après {self.MAX_RETRIES} tentatives: {derniere_erreur}"
        )
```

- [ ] **Step 5 : Câbler la route**

`services/vision/app/main.py`, ajouter aux imports et au corps :

```python
from fastapi import Depends, File, HTTPException, UploadFile

from app.auth import require_service_secret
from app.config import get_settings
from app.detection import ProductDetector


def get_detector() -> ProductDetector:
    settings = get_settings()
    return ProductDetector(api_key=settings.gemini_api_key, model=settings.gemini_model)


@app.post("/detect", dependencies=[Depends(require_service_secret)])
async def detect(
    image: UploadFile = File(...),
    detector: ProductDetector = Depends(get_detector),
) -> dict:
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image vide")
    if len(image_bytes) > get_settings().max_image_bytes:
        raise HTTPException(status_code=413, detail="Image trop volumineuse")

    produits = await detector.detect(image_bytes)
    return {"products": produits, "count": len(produits)}
```

- [ ] **Step 6 : Lancer les tests pour vérifier qu'ils passent**

```bash
cd services/vision && .venv/Scripts/python -m pytest tests/ -v
```

Attendu : 14 tests PASSÉS (2 santé + 7 parsing + 5 détection).

- [ ] **Step 7 : Commit**

```bash
git add services/vision
git commit -m "feat(vision): route de détection protégée par secret partagé"
```

---

### Task 4 : Route `POST /annotate`

**Files:**
- Create: `services/vision/app/annotation.py` (depuis `backend/image_annotator.py`)
- Modify: `services/vision/app/main.py`
- Modify: `services/vision/tests/conftest.py` (fixture d'image réelle)
- Test: `services/vision/tests/test_annotate_route.py`

**Interfaces:**
- Consumes: `app.auth.require_service_secret`, `app.config.get_settings`
- Produces: `app.annotation.annotate_image(image_bytes: bytes, products: list[dict], max_width: int = 1200) -> bytes` ; `POST /annotate` acceptant un fichier `image` et un champ de formulaire `products` (JSON encodé), renvoyant un JPEG brut avec `Content-Type: image/jpeg`.

- [ ] **Step 1 : Ajouter une fixture d'image réelle**

Ajouter à `services/vision/tests/conftest.py` :

```python
import io

from PIL import Image


@pytest.fixture
def image_jpeg() -> bytes:
    """Une vraie image JPEG de 1600x1200, plus large que max_width."""
    tampon = io.BytesIO()
    Image.new("RGB", (1600, 1200), (200, 180, 160)).save(tampon, format="JPEG")
    return tampon.getvalue()
```

- [ ] **Step 2 : Écrire les tests qui échouent**

`services/vision/tests/test_annotate_route.py` :

```python
import io
import json

from PIL import Image

ENTETE = {"X-Vision-Secret": "secret-de-test"}

PRODUITS = [
    {"label": "Tomates", "x": 250, "y": 400, "width": 200, "height": 150,
     "category": "fruits_legumes", "price": "500"},
    {"label": "Poisson fumé", "x": 800, "y": 200, "width": 300, "height": 200,
     "category": "viande_poisson", "price": "1500"},
]


def annoter(client, image_jpeg, produits, headers=ENTETE):
    return client.post(
        "/annotate",
        files={"image": ("etal.jpg", image_jpeg, "image/jpeg")},
        data={"products": json.dumps(produits)},
        headers=headers,
    )


def test_refuse_sans_secret(client, image_jpeg):
    assert annoter(client, image_jpeg, PRODUITS, headers={}).status_code == 401


def test_retourne_un_jpeg_valide(client, image_jpeg):
    reponse = annoter(client, image_jpeg, PRODUITS)
    assert reponse.status_code == 200
    assert reponse.headers["content-type"] == "image/jpeg"

    sortie = Image.open(io.BytesIO(reponse.content))
    assert sortie.format == "JPEG"


def test_redimensionne_en_conservant_le_ratio(client, image_jpeg):
    reponse = annoter(client, image_jpeg, PRODUITS)
    sortie = Image.open(io.BytesIO(reponse.content))
    assert sortie.width == 1200
    assert sortie.height == 900  # 1200x1200/1600, ratio 4:3 conservé


def test_les_produits_marquent_reellement_l_image(client, image_jpeg):
    """Comparer à la sortie sans produit prouve que les badges sont dessinés.

    Comparer à une couleur unie ne prouverait rien : la compression JPEG
    introduit déjà des variations sur une image parfaitement uniforme.
    """
    sans = annoter(client, image_jpeg, []).content
    avec = annoter(client, image_jpeg, PRODUITS).content
    assert avec != sans


def test_accepte_une_liste_de_produits_vide(client, image_jpeg):
    reponse = annoter(client, image_jpeg, [])
    assert reponse.status_code == 200
    assert Image.open(io.BytesIO(reponse.content)).format == "JPEG"


def test_refuse_un_json_de_produits_invalide(client, image_jpeg):
    reponse = client.post(
        "/annotate",
        files={"image": ("etal.jpg", image_jpeg, "image/jpeg")},
        data={"products": "ceci n'est pas du json"},
        headers=ENTETE,
    )
    assert reponse.status_code == 400
```

- [ ] **Step 3 : Lancer les tests pour vérifier qu'ils échouent**

```bash
cd services/vision && .venv/Scripts/python -m pytest tests/test_annotate_route.py -v
```

Attendu : ÉCHEC, les 6 tests renvoient 404 (route inexistante).

- [ ] **Step 4 : Déplacer le module d'annotation**

```bash
git mv backend/image_annotator.py services/vision/app/annotation.py
```

Aucune modification du contenu : le module est déjà sans état et sans dépendance HTTP.

- [ ] **Step 5 : Câbler la route**

Ajouter à `services/vision/app/main.py` :

```python
import json

from fastapi import Form, Response

from app.annotation import annotate_image


@app.post("/annotate", dependencies=[Depends(require_service_secret)])
async def annotate(
    image: UploadFile = File(...),
    products: str = Form(...),
) -> Response:
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image vide")
    if len(image_bytes) > get_settings().max_image_bytes:
        raise HTTPException(status_code=413, detail="Image trop volumineuse")

    try:
        liste_produits = json.loads(products)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="JSON des produits invalide")

    return Response(
        content=annotate_image(image_bytes, liste_produits),
        media_type="image/jpeg",
    )
```

- [ ] **Step 6 : Lancer toute la suite**

```bash
cd services/vision && .venv/Scripts/python -m pytest tests/ -v
```

Attendu : 20 tests PASSÉS.

- [ ] **Step 7 : Commit**

```bash
git add -A services/vision backend
git commit -m "feat(vision): route d'annotation d'image"
```

---

### Task 5 : Retrait du monolithe et des données versionnées

Le service de vision est complet et testé. L'ancien monolithe FastAPI n'a plus de rôle : le lot 2 le remplacera par Medusa. Il sort du dépôt, avec les données qui n'auraient jamais dû y entrer.

**Files:**
- Delete: `backend/` (répertoire entier)
- Modify: `.gitignore`
- Create: `README.md` (section de démarrage local)

**Interfaces:**
- Consumes: rien
- Produces: rien

- [ ] **Step 1 : Archiver le corpus hors de l'arborescence git**

Les 28 catalogues serviront de jeu de validation au plan 3. Ils doivent survivre à la suppression, mais hors du dépôt.

```bash
mkdir -p ../marketlens-archive
cp -r backend/catalogues ../marketlens-archive/
cp -r backend/receipts ../marketlens-archive/
ls ../marketlens-archive/catalogues | wc -l
```

Attendu : `28`.

- [ ] **Step 2 : Retirer les données du suivi git**

```bash
git rm -r --cached backend/catalogues backend/receipts
```

Ajouter à `.gitignore` :

```
# Données d'exécution — jamais versionnées
backend/catalogues/
backend/receipts/
services/vision/.venv/
```

- [ ] **Step 3 : Supprimer le monolithe**

```bash
git rm -r backend
```

`whatsapp_client.py` et `receipt_generator.py` seront portés aux lots 3 et 2. Leur dernière version est récupérable par `git show 23a64ee:backend/whatsapp_client.py`. Cette référence doit figurer dans le message de commit.

- [ ] **Step 4 : Documenter le démarrage local**

Créer `README.md` :

```markdown
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
```

- [ ] **Step 5 : Vérifier que la suite passe toujours**

```bash
cd services/vision && .venv/Scripts/python -m pytest tests/ -v
```

Attendu : 20 tests PASSÉS. Aucune dépendance au répertoire `backend/` supprimé.

- [ ] **Step 6 : Vérifier que le dépôt est propre**

```bash
git status --short
git ls-files | grep -c "backend/"
```

Attendu : `0` fichier `backend/` suivi.

- [ ] **Step 7 : Commit**

```bash
git add -A
git commit -m "chore: retire le monolithe FastAPI et les données versionnées

Le service de vision remplace backend/gemini_vision.py et
backend/image_annotator.py. Le reste sera remplacé par Medusa.

Les catalogues et factures sortent du suivi git : ils contiennent des
numéros de téléphone réels et des factures nominatives.

whatsapp_client.py et receipt_generator.py seront portés aux lots 3 et 2 ;
récupérables via git show 23a64ee:backend/<fichier>."
```

---

## Vérification finale du plan

- [ ] `cd services/vision && .venv/Scripts/python -m pytest tests/ -v` → 20 tests passés
- [ ] Le service démarre sur le port 8001 et répond à `GET /health`
- [ ] `POST /detect` et `POST /annotate` renvoient 401 sans l'en-tête `X-Vision-Secret`
- [ ] Aucun test de la suite par défaut n'appelle l'API Gemini réelle
- [ ] `git ls-files | grep backend/` ne renvoie rien
- [ ] Le corpus des 28 catalogues est archivé dans `../marketlens-archive/`

## Ce que ce plan ne fait pas

Aucun appel réel à Gemini n'est vérifié automatiquement. Avant de considérer le service comme fiable, faire une vérification manuelle unique avec une vraie clé et une vraie photo d'étal issue de l'archive :

```bash
curl -X POST http://localhost:8001/detect \
  -H "X-Vision-Secret: $VISION_SERVICE_SECRET" \
  -F "image=@../marketlens-archive/catalogues/a63c379117/original.jpg"
```

Attendu : un JSON de produits cohérent avec l'image (des jeans, catégorie `textile`).
