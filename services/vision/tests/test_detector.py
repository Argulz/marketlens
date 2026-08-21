"""ProductDetector : appel non bloquant, timeout, réessais, quota.

Aucun de ces tests n'appelle Gemini : le client est substitué.
L'appel réel est couvert par `test_gemini_integration.py`, marqué et
désélectionné par défaut.
"""

import asyncio
import types as pytypes

import httpx
import pytest
from google.genai import errors

from app.detection import (
    DelaiGlobalDepasse,
    DetectionError,
    FormatImageInvalide,
    ProductDetector,
    QuotaGeminiDepasse,
    ConfigurationGeminiRefusee,
    ReponseGeminiInvalide,
)

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
REPONSE_OK = '[{"label": "Tomates", "x": 250, "y": 400, "width": 200, "height": 150}]'


class FauxReponse:
    def __init__(self, text):
        self.text = text


class FauxModelesAsync:
    def __init__(self, resultats):
        self.resultats = list(resultats)
        self.appels = []

    async def generate_content(self, **kwargs):
        self.appels.append(kwargs)
        resultat = self.resultats.pop(0)
        if isinstance(resultat, Exception):
            raise resultat
        return FauxReponse(resultat)


class FauxModelesSync:
    def generate_content(self, **kwargs):
        raise AssertionError(
            "appel synchrone : la boucle d'événements serait gelée pendant "
            "plusieurs secondes, /health compris"
        )


class FauxClient:
    def __init__(self, resultats):
        self.models = FauxModelesSync()
        self.aio = pytypes.SimpleNamespace(models=FauxModelesAsync(resultats))


@pytest.fixture
def gemini(monkeypatch):
    """Substitue genai.Client et neutralise les temporisations."""
    etat = pytypes.SimpleNamespace(client=None, options=None, sommeils=[])

    def fabrique(api_key, http_options=None, **kwargs):
        etat.options = http_options
        return etat.client

    def programmer(*resultats):
        etat.client = FauxClient(resultats)
        return etat

    async def faux_sleep(delai):
        etat.sommeils.append(delai)

    monkeypatch.setattr("app.detection.genai.Client", fabrique)
    monkeypatch.setattr("app.detection.asyncio.sleep", faux_sleep)
    etat.programmer = programmer
    etat.appels = lambda: etat.client.aio.models.appels
    return etat


def detecteur() -> ProductDetector:
    return ProductDetector(api_key="cle-de-test", model="modele-de-test")


def erreur_api(code: int, statut: str) -> errors.APIError:
    reponse = httpx.Response(
        code, json={"error": {"status": statut, "message": "message amont"}}
    )
    return errors.ClientError(code, reponse) if code < 500 else errors.ServerError(
        code, reponse
    )


def test_utilise_le_client_asynchrone(gemini):
    """L'appel synchrone gèlerait tout le processus — le faux client le
    signale en levant si `client.models` est touché."""
    gemini.programmer(REPONSE_OK)
    produits = asyncio.run(detecteur().detect(JPEG))
    assert produits[0]["label"] == "Tomates"
    assert len(gemini.appels()) == 1


def test_configure_un_timeout_explicite(gemini):
    gemini.programmer(REPONSE_OK)
    asyncio.run(detecteur().detect(JPEG))
    assert gemini.options is not None
    assert gemini.options.timeout == ProductDetector.TIMEOUT_MS


def test_refuse_un_format_d_image_inconnu_sans_appeler_gemini(gemini):
    gemini.programmer(REPONSE_OK)
    with pytest.raises(FormatImageInvalide):
        asyncio.run(detecteur().detect(b"\x00\x00\x00\x18ftypheic" + b"\x00" * 32))
    assert gemini.appels() == []


def test_reessaie_avec_une_temporisation_croissante(gemini):
    gemini.programmer(
        erreur_api(503, "UNAVAILABLE"), erreur_api(503, "UNAVAILABLE"), REPONSE_OK
    )
    produits = asyncio.run(detecteur().detect(JPEG))
    assert produits[0]["label"] == "Tomates"
    assert len(gemini.appels()) == 3
    assert gemini.sommeils == [
        ProductDetector.BACKOFF_INITIAL_S,
        ProductDetector.BACKOFF_INITIAL_S * 2,
    ]


def test_ne_temporise_pas_avant_la_premiere_tentative(gemini):
    gemini.programmer(REPONSE_OK)
    asyncio.run(detecteur().detect(JPEG))
    assert gemini.sommeils == []


def test_leve_apres_epuisement_des_tentatives(gemini):
    gemini.programmer(*[erreur_api(503, "UNAVAILABLE")] * ProductDetector.MAX_RETRIES)
    with pytest.raises(DetectionError):
        asyncio.run(detecteur().detect(JPEG))
    assert len(gemini.appels()) == ProductDetector.MAX_RETRIES


def test_remonte_un_quota_depasse_sans_reessayer(gemini):
    """Réessayer immédiatement sur un 429 amplifie la panne : Medusa
    réessaie déjà par-dessus."""
    gemini.programmer(erreur_api(429, "RESOURCE_EXHAUSTED"), REPONSE_OK, REPONSE_OK)
    with pytest.raises(QuotaGeminiDepasse):
        asyncio.run(detecteur().detect(JPEG))
    assert len(gemini.appels()) == 1


def test_ne_reessaie_pas_un_refus_en_texte_libre(gemini):
    """Trois appels Gemini pour un texte de refus qui ne changera pas."""
    refus = "Je ne peux pas analyser cette image."
    gemini.programmer(refus, REPONSE_OK, REPONSE_OK)
    with pytest.raises(ReponseGeminiInvalide):
        asyncio.run(detecteur().detect(JPEG))
    assert len(gemini.appels()) == 1


def test_ne_reessaie_pas_une_erreur_de_programmation(gemini):
    """`except Exception` avalait une TypeError et la réessayait trois fois."""
    gemini.programmer(TypeError("argument inattendu"), REPONSE_OK, REPONSE_OK)
    with pytest.raises(TypeError):
        asyncio.run(detecteur().detect(JPEG))
    assert len(gemini.appels()) == 1


def test_reessaie_sur_une_coupure_reseau(gemini):
    gemini.programmer(httpx.ConnectTimeout("délai dépassé"), REPONSE_OK)
    produits = asyncio.run(detecteur().detect(JPEG))
    assert produits[0]["label"] == "Tomates"
    assert len(gemini.appels()) == 2


def test_le_journal_nomme_le_type_de_panne_meme_sans_message(gemini, caplog):
    """Constaté en préparation de démonstration : le journal affichait
    « Tentative 2/3 échouée: » suivi de rien du tout. Plusieurs erreurs de
    transport de httpx se construisent sans message — `str(e)` est alors la
    chaîne vide, et la ligne de journal ne dit plus RIEN de la panne : ni sa
    nature, ni sa couche. Le type de l'exception, lui, est toujours là."""
    gemini.programmer(httpx.ReadError(""), REPONSE_OK)
    with caplog.at_level("WARNING"):
        asyncio.run(detecteur().detect(JPEG))
    lignes = [e.getMessage() for e in caplog.records if "Tentative" in e.getMessage()]
    assert lignes, "aucune tentative journalisée"
    assert "ReadError" in lignes[0], f"panne anonyme dans le journal : {lignes[0]!r}"


class FauxModelesQuiDorment:
    """Gemini qui ne répond jamais dans le délai imparti — simule un
    service amont accroché plutôt qu'en échec explicite."""

    async def generate_content(self, **kwargs):
        await asyncio.sleep(10)  # jamais atteint : l'échéance globale coupe avant
        raise AssertionError("n'aurait pas dû atteindre la fin du sommeil")


class FauxClientQuiDort:
    def __init__(self):
        self.aio = pytypes.SimpleNamespace(models=FauxModelesQuiDorment())


def test_leve_delai_depasse_quand_l_echeance_globale_expire(monkeypatch):
    """La boucle de réessai entière doit être bornée, pas seulement chaque
    tentative : sans ça, un Gemini qui ne répond jamais laisse le service
    tourner indéfiniment (plutôt que de plafonner à ~181s comme avant)."""
    monkeypatch.setattr(
        "app.detection.genai.Client", lambda **kwargs: FauxClientQuiDort()
    )
    detecteur_impatient = ProductDetector(
        api_key="cle-de-test", model="modele-de-test", deadline_s=0.05
    )
    with pytest.raises(DelaiGlobalDepasse):
        asyncio.run(detecteur_impatient.detect(JPEG))


def test_l_echeance_globale_est_configurable(monkeypatch):
    """Les trois valeurs doivent être observables sur l'instance construite,
    pas gelées dans la classe."""
    monkeypatch.setattr(
        "app.detection.genai.Client", lambda **kwargs: FauxClientQuiDort()
    )
    d = ProductDetector(
        api_key="cle-de-test",
        model="modele-de-test",
        deadline_s=12.0,
        timeout_ms=5_000,
        max_retries=7,
    )
    assert d.deadline_s == 12.0
    assert d.timeout_ms == 5_000
    assert d.max_retries == 7


def test_ne_reessaie_pas_une_cle_api_invalide(gemini):
    """Une clé invalide est une erreur de NOTRE configuration, pas une panne
    amont : la réessayer trois fois est inutile, et la rendre en 502 envoie
    l'exploitant chercher la panne chez Gemini au lieu de son .env."""
    gemini.programmer(erreur_api(400, "INVALID_ARGUMENT"), REPONSE_OK, REPONSE_OK)
    with pytest.raises(ConfigurationGeminiRefusee):
        asyncio.run(detecteur().detect(JPEG))
    assert len(gemini.appels()) == 1


def test_ne_reessaie_pas_un_acces_refuse(gemini):
    """Un 403 est tout aussi déterministe qu'un 400."""
    gemini.programmer(erreur_api(403, "PERMISSION_DENIED"), REPONSE_OK, REPONSE_OK)
    with pytest.raises(ConfigurationGeminiRefusee):
        asyncio.run(detecteur().detect(JPEG))
    assert len(gemini.appels()) == 1
