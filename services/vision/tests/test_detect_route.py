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


class DetecteurEnErreur:
    def __init__(self, erreur):
        self.erreur = erreur

    async def detect(self, image_bytes: bytes) -> list[dict]:
        raise self.erreur


def _detecte_avec(client, erreur, image=IMAGE):
    app.dependency_overrides[get_detector] = lambda: DetecteurEnErreur(erreur)
    try:
        return client.post("/detect", files={"image": image}, headers=ENTETE)
    finally:
        app.dependency_overrides.clear()


def test_renvoie_502_si_le_detecteur_echoue(client):
    reponse = _detecte_avec(
        client, RuntimeError("Échec après 3 tentatives: connexion refusée vers 10.0.0.4")
    )
    assert reponse.status_code == 502


def test_ne_propage_pas_le_message_brut_de_l_erreur_amont(client):
    """Medusa peut faire remonter `detail` jusqu'à l'écran d'un marchand :
    le message doit être stable et en français, jamais celui de l'exception."""
    reponse = _detecte_avec(
        client, RuntimeError("Traceback interne: clé sk-abcd1234 rejetée par 10.0.0.4")
    )
    detail = reponse.json()["detail"]
    assert "sk-abcd1234" not in detail
    assert "10.0.0.4" not in detail
    assert "Traceback" not in detail
    assert detail == "Le service de reconnaissance visuelle est indisponible"


def test_renvoie_429_si_le_quota_amont_est_depasse(client):
    from app.detection import QuotaGeminiDepasse

    reponse = _detecte_avec(client, QuotaGeminiDepasse("429 RESOURCE_EXHAUSTED"))
    assert reponse.status_code == 429


def test_renvoie_400_si_le_format_de_l_image_n_est_pas_reconnu(client, detecteur):
    """Un HEIC partait chez Gemini étiqueté « image/jpeg » et brûlait trois
    tentatives avant un 502 indifférencié."""
    heic = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic" + b"\x00" * 64
    reponse = client.post(
        "/detect", files={"image": ("photo.heic", heic, "image/heic")}, headers=ENTETE
    )
    assert reponse.status_code == 400
    assert detecteur.appels == []


def test_renvoie_500_si_la_cle_api_est_absente(client, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    from app.config import get_settings
    get_settings.cache_clear()

    reponse = client.post("/detect", files={"image": IMAGE}, headers=ENTETE)
    assert reponse.status_code == 500
