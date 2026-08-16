"""Tests d'intégration réels contre Gemini.

Marqués `gemini` et désélectionnés par défaut (`addopts` de pytest.ini) :
ils consomment du quota et dépendent du réseau.

    .venv/Scripts/python -m pytest tests/ -m gemini -v

Sans ces tests, aucune ligne de `ProductDetector.detect` n'est jamais
exécutée contre le vrai SDK — c'est exactement le trou qui a laissé
passer l'appel synchrone bloquant.
"""

import asyncio
import io
import os

import pytest
from PIL import Image, ImageDraw

from app.detection import ALLOWED_CATEGORIES, ProductDetector

# Capturé à l'import : la fixture autouse `environnement` remplace ensuite
# GEMINI_API_KEY par une valeur factice pour toute la suite.
CLE_GEMINI = os.getenv("GEMINI_API_KEY", "")
MODELE = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")

pytestmark = [
    pytest.mark.gemini,
    pytest.mark.skipif(not CLE_GEMINI, reason="GEMINI_API_KEY absente"),
]


@pytest.fixture
def etal_de_marche() -> bytes:
    """Un étal schématique : quelques tas de produits sur une natte."""
    img = Image.new("RGB", (900, 600), (150, 120, 90))
    dessin = ImageDraw.Draw(img)
    tas = [
        ((60, 200, 280, 420), (220, 40, 30)),     # tomates
        ((330, 180, 560, 430), (240, 210, 60)),   # bananes
        ((620, 220, 850, 430), (60, 140, 60)),    # légumes verts
    ]
    for boite, couleur in tas:
        dessin.ellipse(boite, fill=couleur)
    tampon = io.BytesIO()
    img.save(tampon, format="JPEG", quality=90)
    return tampon.getvalue()


def test_detecte_reellement_des_produits(etal_de_marche):
    detecteur = ProductDetector(api_key=CLE_GEMINI, model=MODELE)
    produits = asyncio.run(detecteur.detect(etal_de_marche))

    assert isinstance(produits, list)
    for produit in produits:
        assert set(produit) == {
            "label", "x", "y", "width", "height", "category",
        }
        assert isinstance(produit["label"], str) and produit["label"]
        assert 0 <= produit["x"] <= 1000
        assert 0 <= produit["y"] <= 1000
        assert 20 <= produit["width"] <= 1000
        assert 20 <= produit["height"] <= 1000
        assert produit["category"] in ALLOWED_CATEGORIES
