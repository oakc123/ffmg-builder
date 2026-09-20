"""
Gallery management routes — /gallery/{job_id}/*

Manages project albums and before/after photos for a built site.
Photos stored at  /srv/sites/{job_id}/uploads/{filename}  (served by Caddy).
Project index at  /srv/sites/{job_id}/data/projects.json  (served by Caddy).
"""

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from build_routes import verify_assistant_key

router = APIRouter(prefix="/gallery", tags=["gallery"])
logger = logging.getLogger(__name__)

CADDY_SITES = Path("/srv/sites")
MAX_PHOTO_BYTES = 10 * 1024 * 1024  # 10 MB
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}


def _projects_path(job_id: str) -> Path:
    return CADDY_SITES / job_id / "data" / "projects.json"


def _uploads_dir(job_id: str) -> Path:
    return CADDY_SITES / job_id / "uploads"


def _load(job_id: str) -> list:
    p = _projects_path(job_id)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []


def _dump(job_id: str, projects: list) -> None:
    p = _projects_path(job_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(projects, indent=2, ensure_ascii=False), encoding="utf-8")


def _find(projects: list, project_id: str) -> Optional[dict]:
    return next((p for p in projects if p["id"] == project_id), None)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Models ────────────────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    category: str = "landscape"
    status: str = "in_progress"


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None


# ── Projects ─────────────────────────────────────────────────────────────────

@router.get("/{job_id}/projects")
async def list_projects(job_id: str, _token: str = Depends(verify_assistant_key)):
    return _load(job_id)


@router.post("/{job_id}/projects", status_code=201)
async def create_project(job_id: str, body: ProjectCreate, _token: str = Depends(verify_assistant_key)):
    projects = _load(job_id)
    project = {
        "id": uuid.uuid4().hex[:8],
        "name": body.name,
        "description": body.description,
        "category": body.category,
        "status": body.status,
        "photos": [],
        "createdAt": _now(),
    }
    projects.append(project)
    _dump(job_id, projects)
    logger.info("gallery[%s] project created: %s (%s)", job_id, project["id"], body.name)
    return project


@router.put("/{job_id}/projects/{project_id}")
async def update_project(
    job_id: str, project_id: str, body: ProjectUpdate,
    _token: str = Depends(verify_assistant_key),
):
    projects = _load(job_id)
    project = _find(projects, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    for field in ("name", "description", "category", "status"):
        val = getattr(body, field)
        if val is not None:
            project[field] = val

    _dump(job_id, projects)
    return project


@router.delete("/{job_id}/projects/{project_id}")
async def delete_project(
    job_id: str, project_id: str, _token: str = Depends(verify_assistant_key),
):
    projects = _load(job_id)
    project = _find(projects, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    uploads = _uploads_dir(job_id)
    for photo in project.get("photos", []):
        f = uploads / photo.get("filename", "")
        if f.exists():
            f.unlink()

    _dump(job_id, [p for p in projects if p["id"] != project_id])
    logger.info("gallery[%s] project deleted: %s", job_id, project_id)
    return {"deleted": project_id}


# ── Photos ────────────────────────────────────────────────────────────────────

@router.post("/{job_id}/projects/{project_id}/photos", status_code=201)
async def upload_photo(
    job_id: str,
    project_id: str,
    photo_type: str = Form(...),
    file: UploadFile = File(...),
    _token: str = Depends(verify_assistant_key),
):
    if photo_type not in ("before", "after"):
        raise HTTPException(status_code=400, detail="photo_type must be 'before' or 'after'")
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail="Only JPG, PNG, WEBP images are accepted")

    content = await file.read()
    if len(content) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 10 MB per photo)")

    ext = Path(file.filename or "photo.jpg").suffix.lower() or ".jpg"
    filename = f"{project_id}_{photo_type}_{uuid.uuid4().hex[:8]}{ext}"
    uploads = _uploads_dir(job_id)
    uploads.mkdir(parents=True, exist_ok=True)
    (uploads / filename).write_bytes(content)

    url = f"/{job_id}/uploads/{filename}"
    photo = {
        "id": uuid.uuid4().hex[:8],
        "filename": filename,
        "url": url,
        "type": photo_type,
        "uploadedAt": _now(),
    }

    projects = _load(job_id)
    project = _find(projects, project_id)
    if not project:
        (uploads / filename).unlink(missing_ok=True)
        raise HTTPException(status_code=404, detail="Project not found")

    project.setdefault("photos", []).append(photo)
    _dump(job_id, projects)
    logger.info("gallery[%s] photo uploaded: %s -> %s", job_id, project_id, filename)
    return photo


@router.delete("/{job_id}/projects/{project_id}/photos/{photo_id}")
async def delete_photo(
    job_id: str, project_id: str, photo_id: str,
    _token: str = Depends(verify_assistant_key),
):
    projects = _load(job_id)
    project = _find(projects, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    photo = next((ph for ph in project.get("photos", []) if ph["id"] == photo_id), None)
    if not photo:
        raise HTTPException(status_code=404, detail="Photo not found")

    f = _uploads_dir(job_id) / photo.get("filename", "")
    if f.exists():
        f.unlink()

    project["photos"] = [ph for ph in project["photos"] if ph["id"] != photo_id]
    _dump(job_id, projects)
    return {"deleted": photo_id}


# ── Storage info ──────────────────────────────────────────────────────────────

@router.get("/{job_id}/storage")
async def storage_info(job_id: str, _token: str = Depends(verify_assistant_key)):
    uploads = _uploads_dir(job_id)
    used = sum(f.stat().st_size for f in uploads.glob("*") if f.is_file()) if uploads.exists() else 0
    return {"used_bytes": used, "used_mb": round(used / 1_048_576, 2)}
