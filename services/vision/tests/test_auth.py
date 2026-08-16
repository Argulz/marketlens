"""Authentification par secret partagé — cas limites du secret serveur."""

from app.config import get_settings

IMAGE = ("etal.jpg", b"\xff\xd8\xff\xe0 contenu factice", "image/jpeg")


def test_un_secret_serveur_accentue_rend_401_et_non_500(client, monkeypatch):
    """hmac.compare_digest sur des str lève TypeError hors ASCII.

    Un `.env` francophone (« secret-de-marché ») mettait alors tout le
    service à terre : chaque requête, même légitime, rendait 500.
    """
    monkeypatch.setenv("VISION_SERVICE_SECRET", "secret-de-marché")
    get_settings.cache_clear()

    reponse = client.post(
        "/detect", files={"image": IMAGE}, headers={"X-Vision-Secret": "mauvais"}
    )
    assert reponse.status_code == 401


def test_un_secret_serveur_non_configure_rend_500(client, monkeypatch):
    monkeypatch.setenv("VISION_SERVICE_SECRET", "")
    get_settings.cache_clear()

    reponse = client.post(
        "/detect", files={"image": IMAGE}, headers={"X-Vision-Secret": "peu importe"}
    )
    assert reponse.status_code == 500
    assert "VISION_SERVICE_SECRET" in reponse.json()["detail"]


def test_le_bon_secret_accentue_est_accepte(client, monkeypatch):
    """Symétrique du premier test : le secret accentué doit rester utilisable
    côté serveur dès lors que l'appelant sait l'émettre."""
    monkeypatch.setenv("VISION_SERVICE_SECRET", "secret-de-marché")
    get_settings.cache_clear()

    from app.auth import require_service_secret

    # Appel direct : un client HTTP conforme refuse d'émettre un en-tête
    # non-ASCII, la vérification est donc testée hors transport.
    assert require_service_secret("secret-de-marché") is None
