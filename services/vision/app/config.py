import os
from functools import lru_cache


class Settings:
    def __init__(self) -> None:
        self.gemini_api_key = os.getenv("GEMINI_API_KEY", "")
        self.gemini_model = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")
        self.service_secret = os.getenv("VISION_SERVICE_SECRET", "")
        self.max_image_bytes = int(os.getenv("MAX_IMAGE_BYTES", 20 * 1024 * 1024))
        # Échéance globale de /detect (boucle de réessai Gemini comprise),
        # en secondes. Un appelant (nginx, LB) doit caler son propre
        # timeout au-dessus de cette valeur.
        self.vision_deadline_s = float(os.getenv("VISION_DEADLINE_S", 45))
        # Timeout par tentative Gemini, en millisecondes (unité de
        # google.genai.types.HttpOptions).
        self.vision_timeout_ms = int(os.getenv("VISION_TIMEOUT_MS", 20_000))
        self.vision_max_retries = int(os.getenv("VISION_MAX_RETRIES", 3))


@lru_cache
def get_settings() -> Settings:
    return Settings()
