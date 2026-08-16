import hmac

from fastapi import Header, HTTPException

from app.config import get_settings


def require_service_secret(x_vision_secret: str = Header(default="")) -> None:
    """Vérifie le secret partagé entre Medusa et le service de vision."""
    attendu = get_settings().service_secret
    if not attendu:
        raise HTTPException(status_code=500, detail="VISION_SERVICE_SECRET non configuré")
    if not hmac.compare_digest(x_vision_secret, attendu):
        raise HTTPException(status_code=401, detail="Secret de service invalide")
