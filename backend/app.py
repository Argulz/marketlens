"""
MarketLens — Serveur FastAPI principal
Routes API pour la détection, l'annotation et le paiement.
"""

import os
import io
import json
import base64
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, BackgroundTasks
from fastapi.responses import Response, JSONResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from backend.gemini_vision import detect_products
from backend.image_annotator import annotate_image
from backend.receipt_generator import generate_receipt, get_receipt_path
from backend.mojaloop_client import MojaloopClient
from backend.catalogue_store import save_catalogue, get_catalogue, get_catalogue_image
from backend.whatsapp_client import whatsapp_client

# Charger les variables d'environnement
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Client Mojaloop global
mojaloop_client: MojaloopClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Gère le cycle de vie de l'application."""
    global mojaloop_client
    mojaloop_url = os.getenv("MOJALOOP_API_URL", "http://localhost:4002")
    currency = os.getenv("MOJALOOP_CURRENCY", "XOF")
    mojaloop_client = MojaloopClient(base_url=mojaloop_url, currency=currency)
    logger.info(f"MarketLens démarré — Mojaloop: {mojaloop_url}")
    yield
    if mojaloop_client:
        await mojaloop_client.close()


app = FastAPI(
    title="MarketLens API",
    description="Digitalisation visuelle du commerce informel africain",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/detect")
async def detect(image: UploadFile = File(...)):
    """
    Détecte les produits sur une image de marché via Gemini Vision.
    
    Retourne un JSON avec la liste des produits détectés et leurs coordonnées.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="GEMINI_API_KEY non configurée. Ajoutez-la dans le fichier .env",
        )
    
    image_bytes = await image.read()
    if len(image_bytes) == 0:
        raise HTTPException(status_code=400, detail="Image vide")
    
    if len(image_bytes) > 20 * 1024 * 1024:  # 20 MB max
        raise HTTPException(status_code=400, detail="Image trop volumineuse (max 20 MB)")
    
    try:
        products = await detect_products(image_bytes, api_key)
        return JSONResponse(content={
            "success": True,
            "products": products,
            "count": len(products),
        })
    except Exception as e:
        logger.error(f"Erreur détection: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/annotate")
async def annotate(
    request: Request,
    background_tasks: BackgroundTasks,
    image: UploadFile = File(...),
    products: str = Form(...),
    merchant_phone: str = Form(""),
    merchant_name: str = Form(""),
    merchant_whatsapp: str = Form(""),
):
    """
    Annote une image avec les prix des produits.
    Sauvegarde le catalogue et retourne l'image + l'ID du catalogue.
    """
    image_bytes = await image.read()
    if len(image_bytes) == 0:
        raise HTTPException(status_code=400, detail="Image vide")
    
    try:
        products_list = json.loads(products)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="JSON des produits invalide")
    
    try:
        annotated = annotate_image(image_bytes, products_list)
        
        # Sauvegarder le catalogue pour le lien partageable
        catalogue_id = save_catalogue(
            image_bytes=image_bytes,
            annotated_bytes=annotated,
            products=products_list,
            merchant_phone=merchant_phone,
            merchant_name=merchant_name,
            merchant_whatsapp=merchant_whatsapp,
        )
        
        # Si un numéro WhatsApp est fourni, planifier l'envoi du lien
        if merchant_whatsapp:
            base_url = str(request.base_url).rstrip("/")
            share_url = f"{base_url}/c/{catalogue_id}"
            background_tasks.add_task(
                whatsapp_client.send_catalogue_link,
                vendor_phone=merchant_whatsapp,
                catalogue_url=share_url
            )
        
        # Retourner l'image annotée + l'ID dans un header custom
        return Response(
            content=annotated,
            media_type="image/jpeg",
            headers={
                "Content-Disposition": "inline; filename=catalogue_marketlens.jpg",
                "X-Catalogue-Id": catalogue_id,
            },
        )
    except Exception as e:
        logger.error(f"Erreur annotation: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/pay")
async def pay(
    request: Request,
    background_tasks: BackgroundTasks,
    payer_msisdn: str = Form(...),
    payer_whatsapp: str = Form(""),
    payee_msisdn: str = Form(...),
    amount: str = Form(...),
    catalogue_id: str = Form(""),
    items_json: str = Form("[]"),
):
    """
    Initie un paiement via Mojaloop et génère un reçu.
    Notifie par WhatsApp le client et le marchand.
    """
    if not mojaloop_client:
        raise HTTPException(status_code=500, detail="Client Mojaloop non initialisé")
    
    try:
        # 1. Simuler le paiement
        result = await mojaloop_client.initiate_transfer(
            payer_msisdn=payer_msisdn,
            payee_msisdn=payee_msisdn,
            amount=amount,
        )
        
        # 2. Générer le reçu
        receipt_id = None
        if catalogue_id:
            cat_data = get_catalogue(catalogue_id)
            if cat_data:
                merchant_name = cat_data.get("merchant_name", "Marchand")
                merchant_phone = cat_data.get("merchant_phone", payee_msisdn)
                merchant_whatsapp = cat_data.get("merchant_whatsapp", "")
                items = json.loads(items_json)
                
                receipt_id = generate_receipt(
                    merchant_name=merchant_name,
                    merchant_phone=merchant_phone,
                    payer_phone=payer_msisdn,
                    amount=float(amount),
                    items=items,
                    transfer_id=result.get("transferId", "SIMULATED")
                )
                
                base_url = str(request.base_url).rstrip("/")
                
                # Notification WhatsApp Client (Reçu)
                if payer_whatsapp:
                    receipt_url = f"{base_url}/api/receipt/{receipt_id}"
                    background_tasks.add_task(
                        whatsapp_client.send_receipt_to_customer,
                        customer_whatsapp=payer_whatsapp,
                        receipt_url=receipt_url,
                        vendor_name=merchant_name
                    )
                
                # Notification WhatsApp Vendeur (Nouvelle commande)
                dest_vendor_whatsapp = merchant_whatsapp if merchant_whatsapp else merchant_phone
                if dest_vendor_whatsapp:
                    background_tasks.add_task(
                        whatsapp_client.send_order_notification_to_vendor,
                        vendor_phone=dest_vendor_whatsapp,
                        customer_phone=payer_msisdn,
                        customer_whatsapp=payer_whatsapp,
                        items=items,
                        total=float(amount)
                    )

        return JSONResponse(content={
            "success": True,
            "transfer": result,
            "receipt_id": receipt_id,
        })
    except Exception as e:
        logger.error(f"Erreur paiement: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/receipt/{receipt_id}")
async def download_receipt(receipt_id: str):
    """Télécharge un reçu PDF."""
    path = get_receipt_path(receipt_id)
    if not path:
        raise HTTPException(status_code=404, detail="Reçu introuvable")
    return FileResponse(
        path=path,
        media_type="application/pdf",
        filename=f"Facture_{receipt_id[:8]}.pdf"
    )

@app.get("/api/health")
async def health():
    """Endpoint de santé."""
    return {"status": "ok", "service": "MarketLens"}


# ---- Routes Catalogue Partageable ----

@app.get("/api/catalogue/{catalogue_id}")
async def get_catalogue_data(catalogue_id: str):
    """Retourne les données d'un catalogue (produits, merchant, etc.)."""
    data = get_catalogue(catalogue_id)
    if not data:
        raise HTTPException(status_code=404, detail="Catalogue introuvable")
    return JSONResponse(content=data)


@app.get("/api/catalogue/{catalogue_id}/image")
async def get_catalogue_img(catalogue_id: str):
    """Retourne l'image annotée d'un catalogue."""
    img = get_catalogue_image(catalogue_id, "annotated")
    if not img:
        raise HTTPException(status_code=404, detail="Image introuvable")
    return Response(content=img, media_type="image/jpeg")


@app.get("/c/{catalogue_id}", response_class=HTMLResponse)
async def share_page(catalogue_id: str, request: Request):
    """Page de partage du catalogue interactif."""
    data = get_catalogue(catalogue_id)
    if not data:
        raise HTTPException(status_code=404, detail="Catalogue introuvable")
    
    base_url = str(request.base_url).rstrip("/")
    image_url = f"{base_url}/api/catalogue/{catalogue_id}/image"
    products_json = json.dumps(data["products"], ensure_ascii=False)
    merchant_phone = data.get("merchant_phone", "")
    merchant_name = data.get("merchant_name", "Marchand")
    
    # Lire le template HTML
    share_html_path = os.path.join(
        os.path.dirname(os.path.dirname(__file__)), "frontend", "catalogue_share.html"
    )
    
    if os.path.exists(share_html_path):
        with open(share_html_path, "r", encoding="utf-8") as f:
            html = f.read()
        # Injecter les données
        html = html.replace("{{CATALOGUE_ID}}", catalogue_id)
        html = html.replace("{{IMAGE_URL}}", image_url)
        html = html.replace("{{PRODUCTS_JSON}}", products_json)
        html = html.replace("{{MERCHANT_PHONE}}", merchant_phone)
        html = html.replace("{{MERCHANT_NAME}}", merchant_name)
        html = html.replace("{{BASE_URL}}", base_url)
        return HTMLResponse(content=html)
    
    # Fallback minimal si template absent
    return HTMLResponse(content=f"<html><body><img src='{image_url}' style='max-width:100%'></body></html>")


# Servir le frontend statique (DOIT être en dernier)
frontend_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
if os.path.isdir(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
else:
    logger.warning(f"Dossier frontend non trouvé: {frontend_dir}")
