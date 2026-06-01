"""
Admin portal routes — /admin/*
POST /admin/auth   (unauthenticated — returns ASSISTANT_API_KEY as token)
All other routes   require Bearer ASSISTANT_API_KEY
"""

import base64
import hmac
import json
import logging
import os
import threading
import time
import uuid as uuid_module
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel

from build_routes import (
    verify_assistant_key,
    INTAKE_JOBS_DIR,
    INTAKE_COSTS_DIR,
    _load_job,
    _save_job,
    _find_index_entry,
    _update_index_entry,
)

router = APIRouter(prefix="/admin", tags=["admin"])
logger = logging.getLogger(__name__)

# ── In-memory rate limiter (5 attempts / 15 min per IP) ──────────────────────

_rate_lock = threading.Lock()
_rate_store: dict = defaultdict(list)
_RATE_WINDOW = 15 * 60
_RATE_LIMIT = 5


def _check_rate_limit(ip: str) -> None:
    now = time.time()
    with _rate_lock:
        attempts = _rate_store[ip]
        attempts[:] = [t for t in attempts if now - t < _RATE_WINDOW]
        if len(attempts) >= _RATE_LIMIT:
            raise HTTPException(
                status_code=429,
                detail="Too many login attempts. Try again in 15 minutes.",
            )
        attempts.append(now)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Request models ────────────────────────────────────────────────────────────

class AuthRequest(BaseModel):
    password: str


class TaskPatchRequest(BaseModel):
    task_number: int
    status: str  # "approved" | "rejected"
    rejection_reason: Optional[str] = None


class PackagePatchRequest(BaseModel):
    package: str  # "standard" | "premium"


class StatusPatchRequest(BaseModel):
    status: str


class FlagRequest(BaseModel):
    reason: str


class ReplyRequest(BaseModel):
    body: str


# ── Auth (no auth dependency) ─────────────────────────────────────────────────

@router.post("/auth")
async def admin_auth(body: AuthRequest, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    _check_rate_limit(client_ip)

    admin_password = os.getenv("ADMIN_PASSWORD", "")
    if not admin_password:
        raise HTTPException(status_code=500, detail="ADMIN_PASSWORD not configured")

    if not hmac.compare_digest(body.password, admin_password):
        raise HTTPException(status_code=401, detail="Invalid password")

    assistant_key = os.getenv("ASSISTANT_API_KEY", "")
    if not assistant_key:
        raise HTTPException(status_code=500, detail="ASSISTANT_API_KEY not configured")

    expires_at = (datetime.now(timezone.utc) + timedelta(hours=8)).isoformat()
    return {"token": assistant_key, "expires_at": expires_at}


# ── Jobs list ─────────────────────────────────────────────────────────────────

@router.get("/jobs")
async def list_jobs(
    status: Optional[str] = None,
    search: Optional[str] = None,
    _token: str = Depends(verify_assistant_key),
):
    index_path = INTAKE_JOBS_DIR / "index.jsonl"
    if not index_path.exists():
        return []

    entries = []
    for line in index_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line))
        except Exception:
            continue

    results = []
    for entry in entries:
        job_id = entry.get("job_id", "")

        if status and entry.get("status") != status:
            continue
        if search:
            s = search.lower()
            client = (entry.get("client") or "").lower()
            if s not in client and s not in job_id.lower():
                continue

        job = _load_job(job_id)
        if job is None:
            continue

        results.append({**job, **entry})

    results.sort(
        key=lambda x: x.get("received_at") or x.get("created_at") or "",
        reverse=True,
    )
    return results


# ── Job detail ────────────────────────────────────────────────────────────────

@router.get("/jobs/{job_id}")
async def get_job_detail(job_id: str, _token: str = Depends(verify_assistant_key)):
    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    index_entry = _find_index_entry(job_id)
    if index_entry:
        return {**job, **index_entry}
    return job


# ── Task status update ────────────────────────────────────────────────────────

@router.patch("/jobs/{job_id}/tasks")
async def patch_task(
    job_id: str,
    body: TaskPatchRequest,
    _token: str = Depends(verify_assistant_key),
):
    if body.status not in ("approved", "rejected"):
        raise HTTPException(status_code=422, detail="status must be 'approved' or 'rejected'")

    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    plan = job.get("plan") or {}
    tasks = plan.get("tasks") or []
    for task in tasks:
        if task.get("task_number") == body.task_number:
            task["status"] = body.status
            if body.rejection_reason:
                task["rejection_reason"] = body.rejection_reason
            break
    else:
        raise HTTPException(status_code=404, detail=f"task_number {body.task_number} not found")

    _save_job(job_id, job)
    return {"ok": True, "job_id": job_id, "task_number": body.task_number, "status": body.status}


# ── Job status update ─────────────────────────────────────────────────────────

@router.patch("/jobs/{job_id}/status")
async def patch_job_status(
    job_id: str,
    body: StatusPatchRequest,
    _token: str = Depends(verify_assistant_key),
):
    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    job["status"] = body.status
    _save_job(job_id, job)
    _update_index_entry(job_id, {"status": body.status})
    index_entry = _find_index_entry(job_id)
    return {**job, **(index_entry or {})}


# ── Package update ────────────────────────────────────────────────────────────

@router.patch("/jobs/{job_id}/package")
async def patch_package(
    job_id: str,
    body: PackagePatchRequest,
    _token: str = Depends(verify_assistant_key),
):
    if body.package not in ("standard", "premium"):
        raise HTTPException(status_code=422, detail="package must be 'standard' or 'premium'")

    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    job["package_built"] = body.package
    _save_job(job_id, job)
    _update_index_entry(job_id, {"package_built": body.package})
    return {"ok": True, "job_id": job_id, "package_built": body.package}


# ── Flag / unflag ─────────────────────────────────────────────────────────────

@router.post("/jobs/{job_id}/flag")
async def flag_job(
    job_id: str,
    body: FlagRequest,
    _token: str = Depends(verify_assistant_key),
):
    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    index_entry = _find_index_entry(job_id)
    current_status = (index_entry or {}).get("status") or job.get("status", "pending_approval")

    job["pre_flag_status"] = current_status
    job["status"] = "flagged"
    job["flag_reason"] = body.reason
    job["flagged_at"] = _now()
    _save_job(job_id, job)
    _update_index_entry(job_id, {"status": "flagged", "pre_flag_status": current_status})
    return {"ok": True, "job_id": job_id, "status": "flagged"}


@router.post("/jobs/{job_id}/unflag")
async def unflag_job(job_id: str, _token: str = Depends(verify_assistant_key)):
    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    restore_status = job.get("pre_flag_status", "pending_approval")
    job["status"] = restore_status
    job.pop("pre_flag_status", None)
    job.pop("flag_reason", None)
    job.pop("flagged_at", None)
    _save_job(job_id, job)
    _update_index_entry(job_id, {"status": restore_status, "pre_flag_status": None})
    return {"ok": True, "job_id": job_id, "status": restore_status}


# ── Messages aggregation ──────────────────────────────────────────────────────

@router.get("/messages")
async def list_messages(_token: str = Depends(verify_assistant_key)):
    index_path = INTAKE_JOBS_DIR / "index.jsonl"
    if not index_path.exists():
        return []

    index_entries: dict = {}
    for line in index_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
            jid = entry.get("job_id")
            if jid:
                index_entries[jid] = entry
        except Exception:
            continue

    results = []
    for job_id, entry in index_entries.items():
        job = _load_job(job_id)
        if job is None:
            continue
        messages = job.get("messages") or []
        if not messages:
            continue

        unread = sum(
            1 for m in messages
            if m.get("from") == "customer" and not m.get("read")
        )
        last_msg = messages[-1]
        last_message_at = last_msg.get("sent_at") or last_msg.get("received_at") or ""

        results.append({
            "job_id":          job_id,
            "client":          entry.get("client", ""),
            "status":          entry.get("status", ""),
            "message_count":   len(messages),
            "unread_count":    unread,
            "last_message_at": last_message_at,
            "last_message":    last_msg.get("body", "")[:100],
        })

    results.sort(key=lambda x: x.get("last_message_at") or "", reverse=True)
    return results


# ── Job messages ─────────────────────────────────────────────────────────────

@router.get("/jobs/{job_id}/messages")
async def get_job_messages(job_id: str, _token: str = Depends(verify_assistant_key)):
    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job.get("messages") or []


@router.post("/jobs/{job_id}/reply")
async def send_agent_reply(
    job_id: str,
    body: ReplyRequest,
    _token: str = Depends(verify_assistant_key),
):
    if not body.body.strip():
        raise HTTPException(status_code=422, detail="body is required")
    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    if not isinstance(job.get("messages"), list):
        job["messages"] = []

    msg = {
        "from": "agent",
        "body": body.body.strip(),
        "sent_at": _now(),
        "read": True,
    }
    job["messages"].append(msg)
    _save_job(job_id, job)
    return {"ok": True, "message": msg}


# ── Costs pass-through ────────────────────────────────────────────────────────

@router.get("/costs")
async def list_costs(_token: str = Depends(verify_assistant_key)):
    costs_path = INTAKE_COSTS_DIR / "costs.jsonl"
    if not costs_path.exists():
        return []

    records = []
    for line in costs_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except Exception:
            continue

    records.sort(key=lambda x: x.get("logged_at") or "", reverse=True)
    return records


# ── Change request ────────────────────────────────────────────────────────────

@router.post("/jobs/{job_id}/changes")
async def submit_change_request(
    job_id: str,
    notes: str = Form(...),
    images: List[UploadFile] = File(default=[]),
    _token: str = Depends(verify_assistant_key),
):
    if not notes.strip():
        raise HTTPException(status_code=422, detail="notes is required")

    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    request_id = str(uuid_module.uuid4())

    image_data = []
    for img in images:
        raw = await img.read()
        if raw:
            image_data.append({
                "filename": img.filename,
                "base64": base64.b64encode(raw).decode("utf-8"),
                "content_type": img.content_type or "image/jpeg",
            })

    change_request = {
        "request_id": request_id,
        "notes": notes.strip(),
        "images": image_data,
        "requested_at": _now(),
        "applied": False,
    }

    if not isinstance(job.get("change_requests"), list):
        job["change_requests"] = []

    job["change_requests"].append(change_request)
    _save_job(job_id, job)

    return {"received": True, "request_id": request_id, "job_id": job_id}
