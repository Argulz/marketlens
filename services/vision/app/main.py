import json
import os

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Response, UploadFile

from app.annotation import annotate_image
from app.auth import require_service_secret
from app.config import get_settings
from app.detection import ProductDetector

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

app = FastAPI(title="MarketLens Vision", version="1.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "marketlens-vision"}


def get_detector() -> ProductDetector:
    settings = get_settings()
    if not settings.gemini_api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY non configurée")
    return ProductDetector(api_key=settings.gemini_api_key, model=settings.gemini_model)


@app.post("/detect", dependencies=[Depends(require_service_secret)])
async def detect(
    image: UploadFile = File(...),
    detector: ProductDetector = Depends(get_detector),
) -> dict:
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image vide")
    if len(image_bytes) > get_settings().max_image_bytes:
        raise HTTPException(status_code=413, detail="Image trop volumineuse")

    try:
        produits = await detector.detect(image_bytes)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"products": produits, "count": len(produits)}


@app.post("/annotate", dependencies=[Depends(require_service_secret)])
async def annotate(
    image: UploadFile = File(...),
    products: str = Form(...),
) -> Response:
    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Image vide")
    if len(image_bytes) > get_settings().max_image_bytes:
        raise HTTPException(status_code=413, detail="Image trop volumineuse")

    try:
        liste_produits = json.loads(products)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="JSON des produits invalide")

    return Response(
        content=annotate_image(image_bytes, liste_produits),
        media_type="image/jpeg",
    )
