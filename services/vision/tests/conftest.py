import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import get_settings
from app.main import app


@pytest.fixture(autouse=True)
def environnement(monkeypatch):
    monkeypatch.setenv("VISION_SERVICE_SECRET", "secret-de-test")
    monkeypatch.setenv("GEMINI_API_KEY", "cle-de-test")
    monkeypatch.setenv("GEMINI_MODEL", "modele-de-test")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def image_jpeg() -> bytes:
    """Une vraie image JPEG de 1600x1200, plus large que max_width."""
    tampon = io.BytesIO()
    Image.new("RGB", (1600, 1200), (200, 180, 160)).save(tampon, format="JPEG")
    return tampon.getvalue()
