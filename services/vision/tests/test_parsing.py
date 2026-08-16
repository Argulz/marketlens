from pathlib import Path

import pytest

from app.detection import (
    FormatImageInvalide,
    detect_mime_type,
    parse_json_response,
    validate_products,
)

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


def test_validate_replie_une_categorie_inconnue_sur_autre():
    (produit,) = validate_products(
        [{"label": "Mystère", "category": "poissons_volants"}]
    )
    assert produit["category"] == "autre"


def test_validate_accepte_une_coordonnee_en_chaine_decimale():
    """`int("250.7")` levait : le produit entier disparaissait en silence."""
    (produit,) = validate_products(
        [{"label": "Tomates", "x": "250.7", "y": 400.9, "width": "200",
          "height": 150}]
    )
    assert produit["x"] == 250
    assert produit["y"] == 400
    assert produit["width"] == 200


@pytest.mark.parametrize(
    "octets, attendu",
    [
        (b"\xff\xd8\xff\xe0 jpeg", "image/jpeg"),
        (b"\x89PNG\r\n\x1a\n suite", "image/png"),
        (b"RIFF" + b"\x00" * 4 + b"WEBP suite", "image/webp"),
    ],
)
def test_detect_mime_type_reconnait_les_formats_supportes(octets, attendu):
    assert detect_mime_type(octets) == attendu


def test_detect_mime_type_refuse_un_format_inconnu():
    """Un HEIC retombait silencieusement sur « image/jpeg »."""
    heic = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic"
    with pytest.raises(FormatImageInvalide):
        detect_mime_type(heic)
