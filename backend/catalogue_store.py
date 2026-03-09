"""
MarketLens — Stockage de catalogues
Sauvegarde les catalogues générés pour les rendre accessibles via un lien unique.
"""

import os
import json
import uuid
import time
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Dossier de stockage des catalogues
CATALOGUES_DIR = os.path.join(os.path.dirname(__file__), "catalogues")
os.makedirs(CATALOGUES_DIR, exist_ok=True)


def save_catalogue(
    image_bytes: bytes,
    annotated_bytes: bytes,
    products: list[dict],
    merchant_phone: str = "",
    merchant_name: str = "",
    merchant_whatsapp: str = "",
) -> str:
    """
    Sauvegarde un nouveau catalogue.
    Retourne l'ID unique généré.
    
    Returns:
        ID unique du catalogue
    """
    catalogue_id = uuid.uuid4().hex[:10]
    catalogue_dir = os.path.join(CATALOGUES_DIR, catalogue_id)
    os.makedirs(catalogue_dir, exist_ok=True)
    
    # Sauvegarder l'image annotée
    with open(os.path.join(catalogue_dir, "annotated.jpg"), "wb") as f:
        f.write(annotated_bytes)
    
    # Sauvegarder l'image originale
    with open(os.path.join(catalogue_dir, "original.jpg"), "wb") as f:
        f.write(image_bytes)
    
    # Sauvegarder les métadonnées
    metadata = {
        "id": catalogue_id,
        "products": products,
        "merchant_phone": merchant_phone,
        "merchant_name": merchant_name,
        "merchant_whatsapp": merchant_whatsapp,
        "created_at": time.time(),
    }
    with open(os.path.join(catalogue_dir, "metadata.json"), "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)
    
    logger.info(f"Catalogue sauvegardé: {catalogue_id} ({len(products)} produits)")
    return catalogue_id


def get_catalogue(catalogue_id: str) -> dict | None:
    """
    Récupère un catalogue par son ID.
    
    Returns:
        Dict avec id, products, merchant_phone, merchant_name, created_at ou None
    """
    metadata_path = os.path.join(CATALOGUES_DIR, catalogue_id, "metadata.json")
    if not os.path.exists(metadata_path):
        return None
    
    with open(metadata_path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_catalogue_image(catalogue_id: str, image_type: str = "annotated") -> bytes | None:
    """
    Récupère l'image d'un catalogue.
    
    Args:
        catalogue_id: ID du catalogue
        image_type: "annotated" ou "original"
        
    Returns:
        Image en bytes ou None
    """
    filename = f"{image_type}.jpg"
    image_path = os.path.join(CATALOGUES_DIR, catalogue_id, filename)
    if not os.path.exists(image_path):
        return None
    
    with open(image_path, "rb") as f:
        return f.read()
