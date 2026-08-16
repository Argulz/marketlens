import os
from functools import lru_cache


class Settings:
    def __init__(self) -> None:
        self.gemini_api_key = os.getenv("GEMINI_API_KEY", "")
        self.gemini_model = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")
        self.service_secret = os.getenv("VISION_SERVICE_SECRET", "")
        self.max_image_bytes = int(os.getenv("MAX_IMAGE_BYTES", 20 * 1024 * 1024))


@lru_cache
def get_settings() -> Settings:
    return Settings()
