"""
Polsia Job Intake — FastAPI service for website development briefs.
"""

import asyncio
import json
import logging
import logging.handlers
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
POLSIA_SECRET     = os.getenv("POLSIA_SECRET", "")
OLLAMA_HOST       = os.getenv("OLLAMA_HOST", "http://192.168.0.18:11434")

BASE_DIR = Path(__file__).parent
LOGS_DIR = BASE_DIR / "logs"
JOBS_DIR = BASE_DIR / "jobs"
LOGS_DIR.mkdir(exist_ok=True)
JOBS_DIR.mkdir(exist_ok=True)

MAX_BODY_BYTES = 50 * 1024 * 1024  # 50 MB


# ── Logging ───────────────────────────────────────────────────────────────────

def _make_logger(name: str, filename: str, level=logging.INFO) -> logging.Logger:
    logger = logging.getLogger(name)
    logger.setLevel(level)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    fh = logging.handlers.RotatingFileHandler(
        LOGS_DIR / filename, maxBytes=10_000_000, backupCount=3, encoding="utf-8"
    )
    fh.setFormatter(fmt)
    logger.addHandler(fh)
    return logger

main_log     = _make_logger("intake.main",     "intake.log")
rejected_log = _make_logger("intake.rejected", "rejected.log")
failure_log  = _make_logger("intake.failures", "claude_failures.log")
critical_log = _make_logger("intake.critical", "critical_failures.log")

_sh = logging.StreamHandler()
_sh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
main_log.addHandler(_sh)


# ── Job store helpers ─────────────────────────────────────────────────────────

def _load_job(job_id: str) -> Optional[dict]:
    path = JOBS_DIR / f"{job_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _save_job(job_id: str, data: dict) -> None:
    (JOBS_DIR / f"{job_id}.json").write_text(
        json.dumps(data, indent=2, default=str), encoding="utf-8"
    )


def _find_index_entry(job_id: str) -> Optional[dict]:
    index_path = JOBS_DIR / "index.jsonl"
    if not index_path.exists():
        return None
    for line in index_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
            if entry.get("job_id") == job_id:
                return entry
        except Exception:
            continue
    return None


def _update_index_entry(job_id: str, updates: dict) -> bool:
    index_path = JOBS_DIR / "index.jsonl"
    if not index_path.exists():
        return False
    lines = index_path.read_text(encoding="utf-8").splitlines()
    updated = []
    found = False
    for line in lines:
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
            if entry.get("job_id") == job_id:
                entry.update(updates)
                found = True
            updated.append(json.dumps(entry))
        except Exception:
            updated.append(line)
    if found:
        index_path.write_text("\n".join(updated) + "\n", encoding="utf-8")
    return found


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Auth helper ───────────────────────────────────────────────────────────────

def _require_auth(request: Request, client_ip: str) -> None:
    secret = request.headers.get("x-polsia-secret", "")
    if not secret or secret != POLSIA_SECRET:
        rejected_log.warning("UNAUTHORIZED ip=%s path=%s", client_ip, request.url.path)
        raise HTTPException(status_code=401, detail="Unauthorized")


# ── Prompts ───────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = (
    "You are a website development project planner. You receive a client brief and "
    "produce a structured job plan. Always respond in valid JSON only. "
    "No preamble, no markdown, no explanation outside the JSON."
)

_PLAN_SCHEMA = """{
  "job_id": "same as input",
  "client_summary": "2 sentence summary of who the client is and what they need",
  "recommended_stack": "static HTML/CSS/JS or justify an alternative",
  "estimated_complexity": "low | medium | high",
  "tasks": [
    {
      "task_number": 1,
      "title": "string",
      "description": "string",
      "depends_on": [],
      "status": "pending_approval"
    }
  ],
  "risks": ["array of strings — anything that needs principal attention"],
  "questions_for_client": ["array of strings — anything unclear from the brief"],
  "planned_by": "claude-sonnet"
}"""

_TASK_INSTRUCTIONS = """Tasks must always include in this order:
1. Content Audit (only if existing_site is present, otherwise skip and renumber)
2. Brand Palette Generation
3. Site Architecture
4. Wireframe / Mockup
5. Copywriting (only if copy_status is needs_writing or mixed, otherwise skip)
6. Development
7. QA
8. Package & Deliver"""


def _map_copy_status(content_writing_needed: Optional[str]) -> str:
    return {
        "Yes": "needs_writing",
        "No, I'll provide it": "provided",
        "Mix of both": "mixed",
    }.get(content_writing_needed or "", "mixed")


def _normalize_brief(brief: dict) -> dict:
    """Flatten Polsia shape into a planner-friendly dict."""
    contact  = brief.get("contact") or {}
    project  = brief.get("project") or {}
    brand    = brief.get("brand") or {}
    domain   = brief.get("domain") or {}
    delivery = brief.get("delivery") or {}
    images   = brief.get("images") or []

    tone = project.get("tone", [])
    tone_str = ", ".join(tone) if isinstance(tone, list) else str(tone)

    existing_url = (
        project.get("existing_website_url")
        if project.get("has_existing_website")
        else None
    )

    return {
        "job_id":  brief.get("job_id"),
        "package": brief.get("package"),
        "client": {
            "name":     contact.get("full_name"),
            "business": contact.get("business_name"),
            "industry": contact.get("industry"),
            "email":    contact.get("email"),
        },
        "project": {
            "goal":          project.get("goal"),
            "pages":         project.get("pages"),
            "tone":          tone_str,
            "audience":      project.get("target_audience"),
            "existing_site": existing_url,
            "inspiration":   project.get("inspiration_urls"),
            "copy_status":   _map_copy_status(brand.get("content_writing_needed")),
            "domain_status": domain.get("status", "unsure"),
            "domain_name":   domain.get("name"),
        },
        "brand": {
            "has_logo":          brand.get("has_logo"),
            "colors":            brand.get("colors"),
            "logo_filename":     brand.get("logo_filename"),
            "logo_base64":       brand.get("logo_base64"),
            "logo_content_type": brand.get("logo_content_type"),
        },
        "delivery": {
            "method":      delivery.get("method", "zip"),
            "host_target": delivery.get("host_target"),
        },
        "images_passed": len([i for i in images if i.get("validation") == "pass"]),
        "notes": brief.get("notes"),
    }


def _build_user_prompt(brief: dict) -> str:
    normalized = _normalize_brief(brief)
    return (
        f"Given this client brief: {json.dumps(normalized, indent=2)}\n\n"
        f"Produce a job plan with this exact structure:\n{_PLAN_SCHEMA}\n\n"
        f"{_TASK_INSTRUCTIONS}"
    )


# ── JSON helper ───────────────────────────────────────────────────────────────

def _parse_json_resilient(text: str) -> dict:
    """Strip think-blocks, markdown fences, then parse first JSON object."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    text = re.sub(r"```json\s*|```\s*", "", text).strip()
    start = text.find("{")
    end   = text.rfind("}")
    if start != -1 and end != -1:
        return json.loads(text[start : end + 1])
    raise ValueError(f"No JSON object in response: {text[:300]}")


# ── AI callers ────────────────────────────────────────────────────────────────

async def call_claude(brief: dict) -> dict:
    """Call Claude Sonnet. Timeout 30s. Raises on failure."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-sonnet-4-20250514",
                "max_tokens": 2000,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": _build_user_prompt(brief)}],
            },
        )
        r.raise_for_status()
        text = r.json()["content"][0]["text"]
        plan = _parse_json_resilient(text)
        plan["planned_by"] = "claude-sonnet"
        return plan


async def call_ollama(brief: dict) -> dict:
    """Call qwen3:14b on Ollama. Timeout 120s. Raises on failure."""
    full_prompt = f"{SYSTEM_PROMPT}\n\n{_build_user_prompt(brief)}"
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.post(
            f"{OLLAMA_HOST}/api/generate",
            json={"model": "qwen3:14b", "prompt": full_prompt, "stream": False},
        )
        r.raise_for_status()
        text = r.json()["response"]
        plan = _parse_json_resilient(text)
        plan["planned_by"] = "qwen3:14b-fallback"
        return plan


# ── Pydantic models ───────────────────────────────────────────────────────────

class ContactModel(BaseModel):
    full_name: str
    business_name: str
    industry: str
    email: str
    phone: Optional[str] = None


class ProjectModel(BaseModel):
    goal: str
    target_audience: str
    pages: List[str]
    tone: List[str]
    has_existing_website: Optional[bool] = None
    existing_website_url: Optional[str] = None
    inspiration_urls: Optional[List[str]] = None


class BrandModel(BaseModel):
    has_logo: Optional[bool] = None
    colors: Optional[List[str]] = None
    content_writing_needed: Optional[str] = None
    logo_filename: Optional[str] = None
    logo_base64: Optional[str] = None
    logo_content_type: Optional[str] = None


class ImageAsset(BaseModel):
    filename: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    size_bytes: Optional[int] = None
    format: Optional[str] = None
    validation: Optional[str] = None


class DeliveryModel(BaseModel):
    method: str = "zip"
    host_target: Optional[str] = None
    github_username: Optional[str] = None
    drive_email: Optional[str] = None


class DomainModel(BaseModel):
    status: Optional[str] = "unsure"
    name: Optional[str] = None


class JobBriefRequest(BaseModel):
    job_id: str
    submitted_at: str
    source: str
    package: Optional[str] = None
    customer_uuid: Optional[str] = None
    contact: ContactModel
    project: ProjectModel
    brand: Optional[BrandModel] = None
    images: Optional[List[ImageAsset]] = None
    delivery: Optional[DeliveryModel] = None
    domain: Optional[DomainModel] = None
    notes: Optional[str] = None


class MessageRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    job_id: str
    customer_uuid: str
    sender: str = Field(alias="from")
    body: str
    sent_at: str


class AgentReplyRequest(BaseModel):
    job_id: str
    body: str
    sent_at: str


class PreviewNotificationRequest(BaseModel):
    job_id: str
    customer_uuid: str
    status: str
    preview_url: str
    preview_expires_at: str
    package: str
    pages_built: List[str]
    built_at: str
    notes: Optional[str] = None


class AnsweredQuestion(BaseModel):
    question: str
    answer: str


class JobResponseRequest(BaseModel):
    job_id: str
    customer_uuid: str
    email: str
    response: str
    feedback: Optional[str] = None
    answered_questions: Optional[List[AnsweredQuestion]] = None


# ── App & middleware ──────────────────────────────────────────────────────────

limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="Polsia Job Intake", version="2.0.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.middleware("http")
async def enforce_body_size(request: Request, call_next):
    cl = request.headers.get("content-length")
    if cl and int(cl) > MAX_BODY_BYTES:
        client_ip = request.client.host if request.client else "unknown"
        rejected_log.warning("BODY_TOO_LARGE ip=%s size=%s path=%s", client_ip, cl, request.url.path)
        return JSONResponse(status_code=413, content={"error": "Request body too large (max 50MB)"})
    return await call_next(request)


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status":    "ok",
        "service":   "polsia-intake",
        "version":   "2.0.0",
        "endpoints": [
            "POST /jobs/intake",
            "POST /jobs/preview",
            "POST /jobs/response",
            "POST /messages",
            "GET /messages/{job_id}",
            "POST /messages/agent-reply",
        ],
    }


# ── Intake ────────────────────────────────────────────────────────────────────

@app.post("/jobs/intake")
@limiter.limit("20/hour")
async def intake_job(request: Request):
    client_ip   = request.client.host if request.client else "unknown"
    received_at = _now()

    content_type = request.headers.get("content-type", "")
    if "application/json" not in content_type:
        rejected_log.warning("INVALID_CONTENT_TYPE ip=%s content_type=%r", client_ip, content_type)
        raise HTTPException(status_code=415, detail="Content-Type must be application/json")

    _require_auth(request, client_ip)

    try:
        body = await request.json()
    except Exception:
        rejected_log.warning("INVALID_JSON ip=%s", client_ip)
        raise HTTPException(status_code=422, detail="Invalid JSON body")

    try:
        brief = JobBriefRequest.model_validate(body)
    except Exception as exc:
        rejected_log.warning("VALIDATION_FAILED ip=%s error=%s", client_ip, str(exc)[:300])
        raise HTTPException(status_code=422, detail=str(exc))

    if brief.source != "polsia-intake":
        rejected_log.warning(
            "INVALID_SOURCE ip=%s source=%r job_id=%s", client_ip, brief.source, brief.job_id
        )
        raise HTTPException(status_code=422, detail="source must be 'polsia-intake'")

    if brief.images:
        failed = [
            img.filename or "(unnamed)"
            for img in brief.images
            if img.validation != "pass"
        ]
        if failed:
            rejected_log.warning(
                "IMAGE_VALIDATION_FAILED — continuing without failed images ip=%s job_id=%s images=%s",
                client_ip, brief.job_id, failed,
            )
            brief.images = [i for i in brief.images if i.validation == "pass"]

    customer_uuid = brief.customer_uuid or str(uuid.uuid4())

    main_log.info(
        "INTAKE job_id=%s client=%s customer_uuid=%s ip=%s",
        brief.job_id, brief.contact.business_name, customer_uuid, client_ip,
    )

    brief_dict = brief.model_dump()

    plan       = None
    planned_by = None
    claude_err = None

    if not ANTHROPIC_API_KEY:
        main_log.warning("ANTHROPIC_API_KEY not set — skipping Claude, using Ollama")
        claude_err = "ANTHROPIC_API_KEY not configured"
    else:
        try:
            plan = await call_claude(brief_dict)
            planned_by = "claude-sonnet"
            main_log.info("CLAUDE_SUCCESS job_id=%s", brief.job_id)
        except Exception as exc:
            claude_err = str(exc)
            failure_log.warning("CLAUDE_FAILURE job_id=%s error=%s", brief.job_id, claude_err[:300])
            main_log.warning("Claude failed for job_id=%s — trying Ollama fallback", brief.job_id)

    if plan is None:
        try:
            plan = await call_ollama(brief_dict)
            planned_by = "qwen3:14b-fallback"
            main_log.info("OLLAMA_SUCCESS job_id=%s", brief.job_id)
        except Exception as exc:
            critical_log.error(
                "BOTH_FAILED job_id=%s claude_err=%s ollama_err=%s",
                brief.job_id, claude_err or "skipped", str(exc)[:300],
            )
            return JSONResponse(
                status_code=503,
                content={
                    "error":   "planning_unavailable",
                    "job_id":  brief.job_id,
                    "message": "Both planning engines failed. Job logged for manual review.",
                },
            )

    job_record = {
        "customer_uuid":   customer_uuid,
        "original_brief":  brief_dict,
        "plan":            plan,
        "received_at":     received_at,
        "messages":        [],
    }
    _save_job(brief.job_id, job_record)

    index_entry = {
        "job_id":        brief.job_id,
        "customer_uuid": customer_uuid,
        "client":        brief.contact.business_name,
        "email":         brief.contact.email,
        "status":        "pending_approval",
        "created_at":    received_at,
        "planned_by":    planned_by,
    }
    with open(JOBS_DIR / "index.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps(index_entry) + "\n")

    main_log.info("JOB_SAVED job_id=%s planned_by=%s customer_uuid=%s", brief.job_id, planned_by, customer_uuid)

    return {
        "meta": {
            "job_id":        brief.job_id,
            "customer_uuid": customer_uuid,
            "received_at":   received_at,
            "planned_by":    planned_by,
            "status":        "pending_approval",
        },
        **plan,
    }


# ── Messages ──────────────────────────────────────────────────────────────────

@app.post("/messages")
async def post_message(request: Request):
    client_ip = request.client.host if request.client else "unknown"
    _require_auth(request, client_ip)

    try:
        body = await request.json()
        msg = MessageRequest.model_validate(body)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if not msg.body or not msg.body.strip():
        raise HTTPException(status_code=422, detail="body must not be empty")
    if len(msg.body) > 500:
        raise HTTPException(status_code=422, detail="body exceeds 500 character limit")
    if msg.sender not in ("customer", "agent"):
        raise HTTPException(status_code=422, detail="from must be 'customer' or 'agent'")

    index_entry = _find_index_entry(msg.job_id)
    if not index_entry:
        raise HTTPException(status_code=404, detail="job_id not found")
    if index_entry.get("customer_uuid") != msg.customer_uuid:
        raise HTTPException(status_code=403, detail="customer_uuid does not match job record")

    job = _load_job(msg.job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job file not found")

    message_id = str(uuid.uuid4())
    job.setdefault("messages", []).append({
        "message_id":  message_id,
        "from":        msg.sender,
        "body":        msg.body,
        "sent_at":     msg.sent_at,
        "received_at": _now(),
        "read":        False,
    })
    _save_job(msg.job_id, job)

    main_log.info("MESSAGE job_id=%s from=%s message_id=%s", msg.job_id, msg.sender, message_id)

    return {"message_id": message_id, "job_id": msg.job_id, "received": True}


@app.get("/messages/{job_id}")
async def get_messages(job_id: str, customer_uuid: str, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    _require_auth(request, client_ip)

    index_entry = _find_index_entry(job_id)
    if not index_entry:
        raise HTTPException(status_code=404, detail="job_id not found")
    if index_entry.get("customer_uuid") != customer_uuid:
        raise HTTPException(status_code=403, detail="customer_uuid does not match job record")

    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job file not found")

    messages = job.get("messages", [])

    # Mark all agent messages read — customer has now seen them
    updated = False
    for m in messages:
        if m.get("from") == "agent" and not m.get("read"):
            m["read"] = True
            updated = True
    if updated:
        _save_job(job_id, job)

    return {
        "job_id":        job_id,
        "customer_uuid": customer_uuid,
        "messages": [
            {
                "message_id": m.get("message_id"),
                "from":       m.get("from"),
                "body":       m.get("body"),
                "sent_at":    m.get("sent_at"),
                "read":       m.get("read", False),
            }
            for m in messages
        ],
        "unread_count": 0,
    }


async def _notify_polsia_agent_reply(
    job_id: str, customer_uuid: str, message_id: str, body: str, sent_at: str
) -> None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                "https://funkfactoryos.polsia.app/api/messages/agent-reply",
                headers={
                    "Content-Type":    "application/json",
                    "X-Polsia-Secret": POLSIA_SECRET,
                },
                json={
                    "job_id":        job_id,
                    "customer_uuid": customer_uuid,
                    "message_id":    message_id,
                    "body":          body,
                    "sent_at":       sent_at,
                },
            )
            r.raise_for_status()
            main_log.info("POLSIA_NOTIFY_OK job_id=%s message_id=%s", job_id, message_id)
    except Exception as exc:
        main_log.warning(
            "POLSIA_NOTIFY_FAILED job_id=%s message_id=%s error=%s",
            job_id, message_id, str(exc)[:200],
        )


@app.post("/messages/agent-reply")
async def agent_reply(request: Request):
    client_ip = request.client.host if request.client else "unknown"
    _require_auth(request, client_ip)

    try:
        body = await request.json()
        msg = AgentReplyRequest.model_validate(body)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if not msg.body or not msg.body.strip():
        raise HTTPException(status_code=422, detail="body must not be empty")
    if len(msg.body) > 500:
        raise HTTPException(status_code=422, detail="body exceeds 500 character limit")

    if not _find_index_entry(msg.job_id):
        raise HTTPException(status_code=404, detail="job_id not found")

    job = _load_job(msg.job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job file not found")

    message_id = str(uuid.uuid4())
    job.setdefault("messages", []).append({
        "message_id":  message_id,
        "from":        "agent",
        "body":        msg.body,
        "sent_at":     msg.sent_at,
        "received_at": _now(),
        "read":        False,
    })
    _save_job(msg.job_id, job)

    main_log.info("AGENT_REPLY job_id=%s message_id=%s", msg.job_id, message_id)

    asyncio.create_task(
        _notify_polsia_agent_reply(
            msg.job_id,
            job.get("customer_uuid", ""),
            message_id,
            msg.body,
            msg.sent_at,
        )
    )

    return {"message_id": message_id, "job_id": msg.job_id, "received": True}


# ── Preview notification ──────────────────────────────────────────────────────

@app.post("/jobs/preview")
async def preview_notification(request: Request):
    client_ip = request.client.host if request.client else "unknown"
    _require_auth(request, client_ip)

    try:
        body = await request.json()
        payload = PreviewNotificationRequest.model_validate(body)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if payload.status != "preview_ready":
        raise HTTPException(status_code=422, detail="status must be 'preview_ready'")

    index_entry = _find_index_entry(payload.job_id)
    if not index_entry:
        raise HTTPException(status_code=404, detail="job_id not found")
    if index_entry.get("customer_uuid") != payload.customer_uuid:
        raise HTTPException(status_code=403, detail="customer_uuid does not match job record")

    job = _load_job(payload.job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job file not found")

    job.update({
        "build_status":        "preview_ready",
        "preview_url":         payload.preview_url,
        "preview_expires_at":  payload.preview_expires_at,
        "package":             payload.package,
        "pages_built":         payload.pages_built,
        "built_at":            payload.built_at,
        "preview_notes":       payload.notes,
    })
    _save_job(payload.job_id, job)
    _update_index_entry(payload.job_id, {"status": "preview_ready"})

    main_log.info("PREVIEW_READY job_id=%s url=%s", payload.job_id, payload.preview_url)

    return {
        "received":      True,
        "job_id":        payload.job_id,
        "customer_uuid": payload.customer_uuid,
        "message":       "Preview registered successfully",
    }


# ── Job response ──────────────────────────────────────────────────────────────

@app.post("/jobs/response")
async def job_response(request: Request):
    client_ip = request.client.host if request.client else "unknown"
    _require_auth(request, client_ip)

    try:
        body = await request.json()
        payload = JobResponseRequest.model_validate(body)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if payload.response not in ("approved", "changes_requested"):
        raise HTTPException(status_code=422, detail="response must be 'approved' or 'changes_requested'")
    if payload.response == "changes_requested" and not (payload.feedback or "").strip():
        raise HTTPException(status_code=422, detail="feedback required when requesting changes")

    index_entry = _find_index_entry(payload.job_id)
    if not index_entry:
        raise HTTPException(status_code=404, detail="job_id not found")
    if index_entry.get("customer_uuid") != payload.customer_uuid:
        raise HTTPException(status_code=403, detail="customer_uuid does not match job record")
    if index_entry.get("email") != payload.email:
        raise HTTPException(status_code=403, detail="email does not match job record")

    job = _load_job(payload.job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job file not found")

    answered = (
        [q.model_dump() for q in payload.answered_questions]
        if payload.answered_questions
        else []
    )

    job.update({
        "customer_response":   payload.response,
        "customer_feedback":   payload.feedback or "",
        "answered_questions":  answered,
        "responded_at":        _now(),
    })
    _save_job(payload.job_id, job)

    new_status = "approved" if payload.response == "approved" else "changes_requested"
    _update_index_entry(payload.job_id, {"status": new_status})

    main_log.info("JOB_RESPONSE job_id=%s response=%s", payload.job_id, payload.response)

    return {
        "received":  True,
        "job_id":    payload.job_id,
        "response":  payload.response,
        "message":   "Response recorded successfully",
    }
