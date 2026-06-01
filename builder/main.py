"""
Builder service — website build pipeline and admin portal
Runs on port 8002.
"""
import logging
import logging.handlers
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from build_routes import router as build_router
from admin_routes import router as admin_router


def _setup_logging() -> None:
    log_dir = Path("/app/intake/logs")
    log_dir.mkdir(parents=True, exist_ok=True)

    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    fh = logging.handlers.RotatingFileHandler(
        log_dir / "builder.log", maxBytes=5_000_000, backupCount=3, encoding="utf-8"
    )
    fh.setFormatter(fmt)

    sh = logging.StreamHandler()
    sh.setFormatter(fmt)

    logging.basicConfig(level=logging.INFO, handlers=[fh, sh])


_setup_logging()

app = FastAPI(title="FFMG Builder", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(build_router)
app.include_router(admin_router)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "builder"}
