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
