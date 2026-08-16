"""
MarketLens — Module d'intégration Gemini Vision
Détecte les produits sur une image de marché et retourne leurs coordonnées.
"""

import json
import logging
import re
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

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
                "x": _clamp(int(p.get("x", 500)), 0, 1000),
                "y": _clamp(int(p.get("y", 500)), 0, 1000),
                "width": _clamp(int(p.get("width", 100)), 20, 1000),
                "height": _clamp(int(p.get("height", 100)), 20, 1000),
                "category": category,
            })
        except (ValueError, TypeError, AttributeError) as e:
            logger.warning(f"Produit invalide ignoré: {p} — {e}")
    return validated


def _detect_mime_type(image_bytes: bytes) -> str:
    """Détecte le type MIME à partir des magic bytes."""
    if image_bytes[:3] == b'\xff\xd8\xff':
        return "image/jpeg"
    elif image_bytes[:8] == b'\x89PNG\r\n\x1a\n':
        return "image/png"
    elif image_bytes[:4] == b'RIFF' and image_bytes[8:12] == b'WEBP':
        return "image/webp"
    return "image/jpeg"  # fallback


def _clamp(value: int, min_val: int, max_val: int) -> int:
    return max(min_val, min(max_val, value))


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
