import os

from dotenv import load_dotenv
from fastapi import FastAPI

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

app = FastAPI(title="MarketLens Vision", version="1.0.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "marketlens-vision"}
