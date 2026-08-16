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


# --- Erreurs d'appelant : 400, jamais 500 ---------------------------------
#
# Un 500 sur une erreur d'appelant apprend à Medusa que « réessayer »
# pourrait aider, alors qu'aucun réessai ne corrigera jamais l'entrée.


def test_refuse_des_produits_qui_ne_sont_pas_une_liste(client, image_jpeg):
    reponse = annoter(client, image_jpeg, {"a": 1})
    assert reponse.status_code == 400
    assert "liste" in reponse.json()["detail"].lower()


def test_refuse_un_produit_sans_coordonnees(client, image_jpeg):
    reponse = annoter(client, image_jpeg, [{"label": "X"}])
    assert reponse.status_code == 400


def test_refuse_un_element_qui_n_est_pas_un_objet(client, image_jpeg):
    reponse = annoter(client, image_jpeg, ["bonjour"])
    assert reponse.status_code == 400


def test_refuse_une_image_illisible(client):
    """Un upload tronqué rend 400, pas 500."""
    reponse = annoter(client, b"\xff\xd8\xff\xe0 tronqu\xc3\xa9e", PRODUITS)
    assert reponse.status_code == 400
    assert "illisible" in reponse.json()["detail"].lower()


def test_refuse_une_photo_heic(client):
    """HEIC est le format par défaut de l'iPhone et Pillow ne le lit pas
    sans pillow-heif : le cas est le plus probable de tous."""
    heic = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic" + b"\x00" * 64
    reponse = annoter(client, heic, PRODUITS)
    assert reponse.status_code == 400
