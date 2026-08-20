import json
import logging
import os

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from app.annotation import AnnotationInvalide, annotate_image
from app.auth import require_service_secret
from app.config import get_settings
from app.detection import (
    ConfigurationGeminiRefusee,
    DelaiGlobalDepasse,
    FormatImageInvalide,
    ProductDetector,
    QuotaGeminiDepasse,
    detect_mime_type,
)

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

logger = logging.getLogger(__name__)

app = FastAPI(title="MarketLens Vision", version="1.0.0")

SERVICE_INDISPONIBLE = "Le service de reconnaissance visuelle est indisponible"
DELAI_DEPASSE = (
    "Le délai de traitement de l'image a été dépassé, veuillez réessayer"
)


class ProductOut(BaseModel):
    """Un produit détecté. Coordonnées normalisées 0–1000, origine haut-gauche."""

    label: str
    x: int
    y: int
    width: int
    height: int
    category: str


class DetectResponse(BaseModel):
    products: list[ProductOut]
    count: int


class HealthResponse(BaseModel):
    status: str
    service: str


@app.get("/health")
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="marketlens-vision")


def get_detector() -> ProductDetector:
    settings = get_settings()
    if not settings.gemini_api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY non configurée")
    return ProductDetector(
        api_key=settings.gemini_api_key,
        model=settings.gemini_model,
        deadline_s=settings.vision_deadline_s,
        timeout_ms=settings.vision_timeout_ms,
        max_retries=settings.vision_max_retries,
    )


async def _lire_image_validee(image: UploadFile) -> bytes:
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image vide")
    if len(image_bytes) > get_settings().max_image_bytes:
        raise HTTPException(status_code=413, detail="Image trop volumineuse")
    return image_bytes


@app.post(
    "/detect",
    dependencies=[Depends(require_service_secret)],
    responses={
        400: {"description": "Image vide ou format non reconnu"},
        401: {"description": "Secret de service invalide"},
        413: {"description": "Image trop volumineuse"},
        429: {"description": "Quota Gemini dépassé en amont"},
        500: {"description": "Service mal configuré"},
        502: {"description": "Échec de la détection en amont"},
        504: {"description": "Échéance globale de détection dépassée"},
    },
)
async def detect(
    image: UploadFile = File(...),
    detector: ProductDetector = Depends(get_detector),
) -> DetectResponse:
    image_bytes = await _lire_image_validee(image)

    try:
        # Échouer avant de toucher au détecteur : le format ne dépend pas de
        # lui. Le détecteur redérive le type MIME, dont il a besoin pour le
        # Blob envoyé à Gemini.
        detect_mime_type(image_bytes)
        produits = await detector.detect(image_bytes)
    except FormatImageInvalide as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except QuotaGeminiDepasse as e:
        logger.warning(f"Quota Gemini dépassé: {e}")
        raise HTTPException(
            status_code=429,
            detail="Quota de reconnaissance visuelle dépassé, réessayez plus tard",
        ) from e
    except DelaiGlobalDepasse as e:
        # Doit précéder `except RuntimeError` : DelaiGlobalDepasse en est
        # une sous-classe directe, et une clause parente placée avant
        # ombragerait celle-ci — tout timeout finirait en 502 au lieu de
        # 504, alors que Medusa doit distinguer les deux (refus amont vs
        # absence de réponse à temps).
        logger.warning(f"Échéance globale dépassée: {e}")
        raise HTTPException(status_code=504, detail=DELAI_DEPASSE) from e
    except ConfigurationGeminiRefusee as e:
        # Doit précéder `except RuntimeError` : ConfigurationGeminiRefusee en
        # est une sous-classe, et la clause générique l'ombrerait — le défaut
        # de configuration passerait pour une panne amont.
        logger.error(f"Configuration Gemini refusée: {e}")
        raise HTTPException(status_code=500, detail=str(e)) from e
    except RuntimeError as e:  # DetectionError en est une sous-classe
        # Le détail remonte potentiellement jusqu'à l'écran d'un marchand
        # via Medusa : journaliser la cause, ne renvoyer qu'un message stable.
        logger.error(f"Échec de la détection: {e}")
        raise HTTPException(status_code=502, detail=SERVICE_INDISPONIBLE) from e

    return DetectResponse(products=produits, count=len(produits))


@app.post(
    "/annotate",
    dependencies=[Depends(require_service_secret)],
    response_class=Response,
    responses={
        200: {
            "content": {"image/jpeg": {}},
            "description": "Image annotée en JPEG",
        },
        400: {"description": "Image vide/illisible, ou produits mal formés"},
        401: {"description": "Secret de service invalide"},
        413: {"description": "Image trop volumineuse"},
        500: {"description": "Service mal configuré"},
    },
)
async def annotate(
    image: UploadFile = File(...),
    products: str = Form(...),
) -> Response:
    image_bytes = await _lire_image_validee(image)

    try:
        liste_produits = json.loads(products)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="JSON des produits invalide")

    try:
        image_annotee = await run_in_threadpool(
            annotate_image, image_bytes, liste_produits
        )
    except AnnotationInvalide as e:
        # Type dédié : son message est rédigé pour l'appelant. Une ValueError
        # interne à Pillow resterait un 500, comme il se doit.
        raise HTTPException(status_code=400, detail=str(e)) from e

    return Response(content=image_annotee, media_type="image/jpeg")
