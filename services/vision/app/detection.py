"""
MarketLens — Module d'intégration Gemini Vision
Détecte les produits sur une image de marché et retourne leurs coordonnées.
"""

import asyncio
import json
import logging
import re

import httpx
from google import genai
from google.genai import errors, types

logger = logging.getLogger(__name__)


class FormatImageInvalide(ValueError):
    """L'image fournie n'est d'aucun format que Gemini sait lire (→ 400)."""


class DetectionError(RuntimeError):
    """Échec amont de la détection (→ 502)."""


class QuotaGeminiDepasse(DetectionError):
    """Quota Gemini dépassé en amont (→ 429, et non 502)."""


class ReponseGeminiInvalide(DetectionError):
    """Gemini a répondu autre chose que du JSON. Déterministe : pas de réessai."""


class ConfigurationGeminiRefusee(RuntimeError):
    """Gemini a refusé la requête pour un motif déterministe imputable à
    NOTRE configuration — clé invalide (400 INVALID_ARGUMENT), accès refusé
    (403), modèle inconnu (404) — et non à une panne amont (→ 500).

    Distincte de DetectionError, qui rend 502 : un 502 enverrait l'exploitant
    chercher la panne chez Gemini alors que le défaut est dans son .env.
    Comme elle hérite de RuntimeError, sa clause `except` doit précéder la
    clause générique dans les routes, sans quoi celle-ci l'ombrerait.
    """


class DelaiGlobalDepasse(RuntimeError):
    """L'échéance globale de la requête (boucle de réessai comprise) a
    expiré avant une réponse exploitable (→ 504).

    Distincte de DetectionError : Gemini n'a pas refusé la requête, il n'a
    simplement pas répondu à temps. Medusa doit pouvoir séparer les deux
    cas — ils appellent des conduites différentes en workflow. Comme elle
    hérite directement de RuntimeError (et non de DetectionError), l'ordre
    des `except` côté main.py compte : elle doit être interceptée avant la
    clause générique `except RuntimeError`, sans quoi celle-ci l'ombrerait
    et la renverrait à tort en 502.
    """


ALLOWED_CATEGORIES = {
    "fruits_legumes",
    "viande_poisson",
    "cereales",
    "boissons",
    "textile",
    "electronique",
    "autre",
}

DETECTION_PROMPT = """Tu es un expert en reconnaissance de produits sur les marchés africains.
Analyse cette image d'un étal de marché ou de produits à vendre.

Pour CHAQUE produit visible, retourne un objet JSON avec :
- "label": nom du produit en français (ex: "Tomates", "Bananes plantain", "Poisson fumé")
- "x": coordonnée X du centre du produit (0-1000, où 0=gauche, 1000=droite)
- "y": coordonnée Y du centre du produit (0-1000, où 0=haut, 1000=bas)
- "width": largeur approximative du produit (0-1000)
- "height": hauteur approximative du produit (0-1000)
- "category": catégorie parmi ["fruits_legumes", "viande_poisson", "cereales", "boissons", "textile", "electronique", "autre"]

Retourne UNIQUEMENT un tableau JSON valide, sans texte avant ou après.
Exemple: [{"label": "Tomates", "x": 250, "y": 400, "width": 200, "height": 150, "category": "fruits_legumes"}]

Détecte un maximum de produits distincts. Si tu vois un tas d'un même produit, compte-le comme un seul élément.
"""


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
            category = p.get("category", "autre")
            if category not in ALLOWED_CATEGORIES:
                category = "autre"
            validated.append({
                "label": str(p.get("label", "Produit")),
                # int(float(...)) : une coordonnée en chaîne décimale
                # (« 250.7 ») faisait disparaître le produit entier.
                "x": _clamp(int(float(p.get("x", 500))), 0, 1000),
                "y": _clamp(int(float(p.get("y", 500))), 0, 1000),
                "width": _clamp(int(float(p.get("width", 100))), 20, 1000),
                "height": _clamp(int(float(p.get("height", 100))), 20, 1000),
                "category": category,
            })
        except (ValueError, TypeError, AttributeError) as e:
            logger.warning(f"Produit invalide ignoré: {p} — {e}")
    return validated


def detect_mime_type(image_bytes: bytes) -> str:
    """Détecte le type MIME à partir des magic bytes.

    Lève FormatImageInvalide si les octets ne correspondent à aucun format
    reconnu. L'ancien repli silencieux sur « image/jpeg » envoyait un HEIC
    — format par défaut de l'iPhone — mal étiqueté à Gemini, brûlant trois
    tentatives avant un 502 qui n'expliquait rien.
    """
    if image_bytes[:3] == b'\xff\xd8\xff':
        return "image/jpeg"
    elif image_bytes[:8] == b'\x89PNG\r\n\x1a\n':
        return "image/png"
    elif image_bytes[:4] == b'RIFF' and image_bytes[8:12] == b'WEBP':
        return "image/webp"
    raise FormatImageInvalide(
        "Format d'image non reconnu : seuls JPEG, PNG et WebP sont acceptés"
    )


def _clamp(value: int, min_val: int, max_val: int) -> int:
    return max(min_val, min(max_val, value))


class ProductDetector:
    """Encapsule l'appel à Gemini. Substituable en test."""

    MAX_RETRIES = 3
    #: Timeout par appel Gemini, en millisecondes (unité de HttpOptions).
    TIMEOUT_MS = 20_000
    #: Échéance globale de la requête entière (boucle de réessai comprise),
    #: en secondes. Avant son introduction, chaque tentative avait sa
    #: propre borne mais l'ensemble n'en avait aucune : 3 tentatives à 60s
    #: plus le backoff pouvaient river le service ~181s, bien au-delà des
    #: timeouts nginx/LB par défaut (60s) — l'appelant avait déjà coupé.
    DEADLINE_S = 45.0
    #: Temporisation avant le 2e essai ; doublée à chaque essai suivant.
    BACKOFF_INITIAL_S = 0.5

    def __init__(
        self,
        api_key: str,
        model: str,
        deadline_s: float | None = None,
        timeout_ms: int | None = None,
        max_retries: int | None = None,
    ) -> None:
        self.api_key = api_key
        self.model = model
        self.deadline_s = self.DEADLINE_S if deadline_s is None else deadline_s
        self.timeout_ms = self.TIMEOUT_MS if timeout_ms is None else timeout_ms
        self.max_retries = self.MAX_RETRIES if max_retries is None else max_retries

    async def detect(self, image_bytes: bytes) -> list[dict]:
        """Détecte les produits visibles. Ne bloque jamais la boucle d'événements.

        Borne la boucle de réessai entière par `deadline_s`, en plus du
        timeout par tentative (`timeout_ms`) : les deux bornes existent
        pour des raisons différentes — l'une évite qu'un appel individuel
        pende, l'autre évite que l'addition des tentatives + backoff
        dépasse ce qu'un appelant (nginx, LB) est prêt à attendre.

        Raises:
            FormatImageInvalide: octets d'aucun format reconnu (→ 400).
            QuotaGeminiDepasse: quota amont dépassé (→ 429).
            ReponseGeminiInvalide: réponse non-JSON, non réessayée (→ 502).
            DetectionError: échec amont après max_retries tentatives (→ 502).
            DelaiGlobalDepasse: échéance globale expirée (→ 504).
        """
        mime_type = detect_mime_type(image_bytes)
        client = genai.Client(
            api_key=self.api_key,
            http_options=types.HttpOptions(timeout=self.timeout_ms),
        )
        logger.info(
            f"Envoi à Gemini ({len(image_bytes)} octets, {mime_type}, {self.model})"
        )

        try:
            return await asyncio.wait_for(
                self._detect_avec_reessais(client, mime_type, image_bytes),
                timeout=self.deadline_s,
            )
        except asyncio.TimeoutError as e:
            raise DelaiGlobalDepasse(
                f"Échéance globale de {self.deadline_s:.0f}s dépassée"
            ) from e

    async def _detect_avec_reessais(
        self, client, mime_type: str, image_bytes: bytes
    ) -> list[dict]:
        derniere_erreur: Exception | None = None
        for tentative in range(self.max_retries):
            if tentative:
                # Sans temporisation, trois appels immédiats amplifient la
                # panne amont — et Medusa réessaie déjà par-dessus.
                delai = self.BACKOFF_INITIAL_S * 2 ** (tentative - 1)
                logger.info(f"Nouvelle tentative dans {delai:.1f}s")
                await asyncio.sleep(delai)
            try:
                response = await client.aio.models.generate_content(
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
            except errors.APIError as e:
                code = getattr(e, "code", None)
                if code == 429:
                    raise QuotaGeminiDepasse(
                        "Quota Gemini dépassé en amont"
                    ) from e
                if isinstance(code, int) and 400 <= code < 500:
                    # Déterministe : la même requête échouera identiquement.
                    raise ConfigurationGeminiRefusee(
                        f"Gemini a refusé la requête ({code}) : "
                        "vérifiez GEMINI_API_KEY et GEMINI_MODEL"
                    ) from e
                derniere_erreur = e
                logger.warning(
                    f"Tentative {tentative + 1}/{self.max_retries} échouée: "
                    f"{type(e).__name__}: {e}"
                )
                continue
            except (httpx.HTTPError, asyncio.TimeoutError,
                    TimeoutError, ConnectionError) as e:
                # Erreurs de transport uniquement : un `except Exception`
                # avalerait une erreur de programmation et la réessaierait.
                derniere_erreur = e
                logger.warning(
                    f"Tentative {tentative + 1}/{self.max_retries} échouée: "
                    f"{type(e).__name__}: {e}"
                )
                continue

            texte = (getattr(response, "text", None) or "").strip()
            if not texte:
                derniere_erreur = DetectionError("Réponse Gemini vide")
                logger.warning(
                    f"Tentative {tentative + 1}/{self.max_retries}: réponse vide"
                )
                continue

            try:
                produits = parse_json_response(texte)
            except ValueError as e:
                # Déterministe : un refus en texte libre ne deviendra pas du
                # JSON au troisième appel.
                raise ReponseGeminiInvalide(
                    "Gemini n'a pas répondu en JSON exploitable"
                ) from e

            valides = validate_products(produits)
            logger.info(f"Produits détectés: {len(valides)}")
            return valides

        raise DetectionError(
            f"Échec de la détection après {self.max_retries} tentatives: "
            f"{derniere_erreur}"
        )
