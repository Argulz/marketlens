# MarketLens

Digitalisation visuelle du commerce informel africain.

Migration en cours vers Medusa v2 — voir
`docs/superpowers/specs/2026-08-16-marketlens-medusa-socle-design.md`.

## Services

| Service | Port | État |
|---|---|---|
| `services/vision` | 8001 | Opérationnel |
| `marketlens-commerce` (Medusa) | 9000 | Plan 2 |
| `marketlens-web` (Next.js) | 8000 | Plan 4 |

## Démarrer le service de vision

    cd services/vision
    python -m venv .venv
    .venv/Scripts/python -m pip install -r requirements.txt
    cp .env.example .env        # puis renseigner GEMINI_API_KEY et VISION_SERVICE_SECRET
    .venv/Scripts/python -m uvicorn app.main:app --port 8001 --reload

Tests :

    cd services/vision && .venv/Scripts/python -m pytest tests/ -v
