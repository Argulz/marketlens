"""Troisième propriété de la spec : les badges restent dans les bornes.

C'est la seule des trois qui protège une vraie logique — le bornage de
`_position_badge`. Format JPEG et dimensions sont couverts ailleurs.
"""

import io

import pytest
from PIL import Image

from app.annotation import _position_badge, annotate_image

IMG_W, IMG_H = 1200, 900
BADGE_W, BADGE_H = 140, 60

# Les quatre coins, le centre, et des valeurs extrêmes hors échelle.
COORDONNEES = [
    (0, 0), (1000, 0), (0, 1000), (1000, 1000),
    (500, 500), (1000, 1000), (-500, -500), (5000, 5000),
]


@pytest.mark.parametrize("x, y", COORDONNEES)
@pytest.mark.parametrize("largeur, hauteur", [(20, 20), (1000, 1000)])
def test_le_badge_reste_dans_les_bornes(x, y, largeur, hauteur):
    cx = int(x / 1000 * IMG_W)
    cy = int(y / 1000 * IMG_H)
    ph = int(hauteur / 1000 * IMG_H)
    y1 = cy - ph // 2

    bx, by = _position_badge(cx, y1, BADGE_W, BADGE_H, IMG_W, IMG_H)

    assert 0 <= bx, f"badge à gauche de l'image: {bx}"
    assert 0 <= by, f"badge au-dessus de l'image: {by}"
    assert bx + BADGE_W <= IMG_W, f"badge débordant à droite: {bx + BADGE_W}"
    assert by + BADGE_H <= IMG_H, f"badge débordant en bas: {by + BADGE_H}"


def test_un_badge_plus_grand_que_l_image_reste_ancre_dans_l_image():
    """Cas dégénéré : il ne peut pas tenir, il ne doit pas partir hors champ."""
    bx, by = _position_badge(0, 0, IMG_W + 400, IMG_H + 400, IMG_W, IMG_H)
    assert (bx, by) == (4, 4)


def _image_unie(largeur=1600, hauteur=1200) -> bytes:
    tampon = io.BytesIO()
    Image.new("RGB", (largeur, hauteur), (255, 255, 255)).save(tampon, format="JPEG")
    return tampon.getvalue()


def test_annote_les_coordonnees_extremes_sans_deformer_l_image():
    produits = [
        {"label": "Coin haut-gauche", "x": 0, "y": 0, "width": 20, "height": 20,
         "category": "fruits_legumes", "price": "500"},
        {"label": "Coin haut-droit", "x": 1000, "y": 0, "width": 20, "height": 20,
         "category": "boissons", "price": "750"},
        {"label": "Coin bas-gauche", "x": 0, "y": 1000, "width": 20, "height": 20,
         "category": "cereales", "price": "1000"},
        {"label": "Coin bas-droit", "x": 1000, "y": 1000, "width": 20, "height": 20,
         "category": "textile", "price": "1250"},
        {"label": "Démesuré", "x": 1000, "y": 1000, "width": 1000, "height": 1000,
         "category": "autre", "price": "9999"},
    ]
    sortie = Image.open(io.BytesIO(annotate_image(_image_unie(), produits)))

    assert sortie.format == "JPEG"
    assert sortie.size == (1200, 900)
