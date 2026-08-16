import hmac

from fastapi import Header, HTTPException

from app.config import get_settings


def require_service_secret(x_vision_secret: str = Header(default="")) -> None:
    """Vérifie le secret partagé entre Medusa et le service de vision."""
    attendu = get_settings().service_secret
    if not attendu:
        raise HTTPException(status_code=500, detail="VISION_SERVICE_SECRET non configuré")
    # Comparer des bytes et non des str : hmac.compare_digest lève TypeError
    # dès qu'une des deux chaînes sort de l'ASCII (« secret-de-marché »).
    if not hmac.compare_digest(x_vision_secret.encode("utf-8"), attendu.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Secret de service invalide")
