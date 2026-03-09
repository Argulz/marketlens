"""
MarketLens — Module d'intégration Gemini Vision
Détecte les produits sur une image de marché et retourne leurs coordonnées.
"""

import json
import base64
import logging
import re
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

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


async def detect_products(image_bytes: bytes, api_key: str) -> list[dict]:
    """
    Envoie une image à Gemini Vision et retourne les produits détectés.
    
    Args:
        image_bytes: L'image en bytes
        api_key: Clé API Gemini
        
    Returns:
        Liste de dicts avec label, x, y, width, height, category
    """
    client = genai.Client(api_key=api_key)
    
    # Encoder l'image en base64
    image_b64 = base64.b64encode(image_bytes).decode("utf-8")
    
    # Déterminer le type MIME
    mime_type = _detect_mime_type(image_bytes)
    
    logger.info(f"Envoi de l'image à Gemini ({len(image_bytes)} bytes, {mime_type})")
    
    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = client.models.generate_content(
                model="gemini-3-flash-preview",
                # model="gemini-2.5-flash",
                contents=[
                    types.Content(
                        parts=[
                            types.Part(
                                inline_data=types.Blob(
                                    mime_type=mime_type,
                                    data=image_bytes,
                                )
                            ),
                            types.Part(text=DETECTION_PROMPT),
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    max_output_tokens=4096,
                ),
            )
            
            raw_text = response.text.strip()
            logger.info(f"Réponse Gemini brute: {raw_text[:200]}...")
            
            # Extraire le JSON du texte (parfois entouré de ```json ... ```)
            products = _parse_json_response(raw_text)
            
            # Valider et nettoyer
            validated = _validate_products(products)
            logger.info(f"Produits détectés: {len(validated)}")
            return validated
            
        except Exception as e:
            logger.warning(f"Tentative {attempt + 1}/{max_retries} échouée: {e}")
            if attempt == max_retries - 1:
                raise RuntimeError(f"Échec de la détection après {max_retries} tentatives: {e}")
    
    return []


def _detect_mime_type(image_bytes: bytes) -> str:
    """Détecte le type MIME à partir des magic bytes."""
    if image_bytes[:3] == b'\xff\xd8\xff':
        return "image/jpeg"
    elif image_bytes[:8] == b'\x89PNG\r\n\x1a\n':
        return "image/png"
    elif image_bytes[:4] == b'RIFF' and image_bytes[8:12] == b'WEBP':
        return "image/webp"
    return "image/jpeg"  # fallback


def _parse_json_response(text: str) -> list:
    """Parse la réponse JSON de Gemini, en gérant les blocs de code."""
    # Retirer les blocs ```json ... ```
    cleaned = re.sub(r'```(?:json)?\s*', '', text)
    cleaned = cleaned.strip()
    
    try:
        result = json.loads(cleaned)
        if isinstance(result, list):
            return result
        elif isinstance(result, dict) and "products" in result:
            return result["products"]
        return [result]
    except json.JSONDecodeError as e:
        logger.error(f"Erreur de parsing JSON: {e}\nTexte: {cleaned[:500]}")
        raise ValueError(f"Réponse Gemini non-JSON valide: {e}")


def _validate_products(products: list) -> list[dict]:
    """Valide et normalise les produits détectés."""
    validated = []
    for p in products:
        try:
            item = {
                "label": str(p.get("label", "Produit")),
                "x": _clamp(int(p.get("x", 500)), 0, 1000),
                "y": _clamp(int(p.get("y", 500)), 0, 1000),
                "width": _clamp(int(p.get("width", 100)), 20, 1000),
                "height": _clamp(int(p.get("height", 100)), 20, 1000),
                "category": p.get("category", "autre"),
            }
            validated.append(item)
        except (ValueError, TypeError) as e:
            logger.warning(f"Produit invalide ignoré: {p} — {e}")
    return validated


def _clamp(value: int, min_val: int, max_val: int) -> int:
    return max(min_val, min(max_val, value))
