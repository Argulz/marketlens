import pytest
from fastapi.testclient import TestClient

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
