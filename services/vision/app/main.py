import json
import logging
import os

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from app.annotation import annotate_image
from app.auth import require_service_secret
from app.config import get_settings
from app.detection import (
    DetectionError,
    FormatImageInvalide,
    ProductDetector,
    QuotaGeminiDepasse,
    detect_mime_type,
)

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

logger = logging.getLogger(__name__)

app = FastAPI(title="MarketLens Vision", version="1.0.0")

SERVICE_INDISPONIBLE = "Le service de reconnaissance visuelle est indisponible"


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
    return ProductDetector(api_key=settings.gemini_api_key, model=settings.gemini_model)


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
    },
)
async def detect(
    image: UploadFile = File(...),
    detector: ProductDetector = Depends(get_detector),
) -> DetectResponse:
    image_bytes = await _lire_image_validee(image)

    try:
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
    except (DetectionError, RuntimeError) as e:
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
    except ValueError as e:
        # Messages levés par app.annotation : rédigés pour l'appelant, sûrs.
        raise HTTPException(status_code=400, detail=str(e)) from e

    return Response(content=image_annotee, media_type="image/jpeg")
