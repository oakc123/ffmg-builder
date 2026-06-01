"""
Build pipeline routes — /build/trigger, /intake/costs/summary, /jobs/{job_id}/status
"""

import asyncio
import base64
import hmac
import io
import json
import logging
import logging.handlers
import os
import re
import shutil
import subprocess
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

import anthropic as _anthropic
import httpx

try:
    from PIL import Image as _PILImage
    _PILLOW_OK = True
except ImportError:
    _PILLOW_OK = False

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Header, HTTPException, UploadFile
from typing import List
from pydantic import BaseModel

# ── Paths ─────────────────────────────────────────────────────────────────────

INTAKE_JOBS_DIR    = Path(os.getenv("INTAKE_JOBS_DIR",    "/app/intake/jobs"))
INTAKE_COSTS_DIR   = Path(os.getenv("INTAKE_COSTS_DIR",   "/app/intake/costs"))
INTAKE_LOGS_DIR    = Path(os.getenv("INTAKE_LOGS_DIR",    "/app/intake/logs"))
WEBSITE_BUILDS_DIR = Path(os.getenv("WEBSITE_BUILDS_DIR", "/app/website-builds"))

for _d in (INTAKE_JOBS_DIR, INTAKE_COSTS_DIR, INTAKE_LOGS_DIR, WEBSITE_BUILDS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# ── Env vars ──────────────────────────────────────────────────────────────────

ANTHROPIC_API_KEY  = os.getenv("ANTHROPIC_API_KEY", "")
POLSIA_SECRET      = os.getenv("POLSIA_SECRET", "")
GITHUB_PAT         = os.getenv("GITHUB_PAT", "")
GITHUB_REPO        = os.getenv("GITHUB_REPO", "https://github.com/oakc123/website-builder.git")
POLSIA_PREVIEW_URL = "https://funkfactoryos.polsia.app/api/preview"
PREVIEW_DOMAIN     = os.getenv("PREVIEW_DOMAIN",  "preview.funkfactorymediagroup.com")


# ── Logging ───────────────────────────────────────────────────────────────────

def _make_logger(name: str, filename: str) -> logging.Logger:
    log = logging.getLogger(name)
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    fh = logging.handlers.RotatingFileHandler(
        INTAKE_LOGS_DIR / filename, maxBytes=5_000_000, backupCount=3, encoding="utf-8"
    )
    fh.setFormatter(fmt)
    log.addHandler(fh)
    return log


build_fail_log    = _make_logger("build.failures", "build_failures.log")
build_success_log = _make_logger("build.success",  "build_success.log")
costs_log         = _make_logger("build.costs",    "costs.log")
build_log         = logging.getLogger("build")


# ── Auth dependency ───────────────────────────────────────────────────────────

async def verify_assistant_key(authorization: str = Header(...)):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    token = authorization.replace("Bearer ", "", 1)
    assistant_key = os.getenv("ASSISTANT_API_KEY", "")
    if not assistant_key:
        raise HTTPException(status_code=500, detail="ASSISTANT_API_KEY not configured")
    if not hmac.compare_digest(token, assistant_key):
        raise HTTPException(status_code=401, detail="Invalid API key")
    return token


# ── Job store helpers ─────────────────────────────────────────────────────────

def _load_job(job_id: str) -> Optional[dict]:
    path = INTAKE_JOBS_DIR / f"{job_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _save_job(job_id: str, data: dict) -> None:
    (INTAKE_JOBS_DIR / f"{job_id}.json").write_text(
        json.dumps(data, indent=2, default=str), encoding="utf-8"
    )


def _find_index_entry(job_id: str) -> Optional[dict]:
    index_path = INTAKE_JOBS_DIR / "index.jsonl"
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
    index_path = INTAKE_JOBS_DIR / "index.jsonl"
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


# ── Cost helpers ──────────────────────────────────────────────────────────────

def _log_cost(job_id: str, business_name: str, operation: str, model_used: str,
              input_tokens: int, output_tokens: int, cost_usd: float) -> None:
    record = {
        "job_id":        job_id,
        "business_name": business_name,
        "operation":     operation,
        "model_used":    model_used,
        "input_tokens":  input_tokens,
        "output_tokens": output_tokens,
        "cost_usd":      round(cost_usd, 6),
        "logged_at":     _now(),
    }
    with open(INTAKE_COSTS_DIR / "costs.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")
    costs_log.info(
        "COST job_id=%s op=%s model=%s in=%d out=%d cost=$%.4f",
        job_id, operation, model_used, input_tokens, output_tokens, cost_usd,
    )


def _cost_entry_exists(job_id: str, operation: str) -> bool:
    costs_path = INTAKE_COSTS_DIR / "costs.jsonl"
    if not costs_path.exists():
        return False
    for line in costs_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            e = json.loads(line)
            if e.get("job_id") == job_id and e.get("operation") == operation:
                return True
        except Exception:
            continue
    return False


# ── Prompt safety helpers ─────────────────────────────────────────────────────

_B64_RE = re.compile(r'data:[a-zA-Z]+/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{20,}')

def _scrub_b64(text: str) -> str:
    """Replace any base64 data URIs in text with a short placeholder."""
    return _B64_RE.sub('[image-data-stripped]', text)


def _scrub_obj(obj):
    """Recursively strip 'base64' keys from dicts — for prompt-safe brief/change data."""
    if isinstance(obj, dict):
        return {k: ('[base64-stripped]' if k == 'base64' else _scrub_obj(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub_obj(i) for i in obj]
    return obj


# ── JSON parse helper ─────────────────────────────────────────────────────────

def _repair_json_strings(text: str) -> str:
    """Fix literal control characters inside JSON string values."""
    result      = []
    in_string   = False
    escape_next = False
    for ch in text:
        if escape_next:
            escape_next = False
            result.append(ch)
        elif ch == "\\" and in_string:
            escape_next = True
            result.append(ch)
        elif ch == '"':
            in_string = not in_string
            result.append(ch)
        elif in_string and ch == "\n":
            result.append("\\n")
        elif in_string and ch == "\r":
            result.append("\\r")
        elif in_string and ch == "\t":
            result.append("\\t")
        else:
            result.append(ch)
    return "".join(result)


def _normalize_escaped_quotes(text: str) -> str:
    """Convert double-escaped quotes \\" → \" so JSON strings don't terminate early.

    Claude sometimes writes lang=\\"en\\" meaning lang="en" but in JSON \\
    is an escaped backslash and the following " terminates the string.
    Normalising \\" → \" fixes this before the JSON parser sees it.
    """
    return text.replace('\\\\"', '\\"')


def _extract_content_fallback(text: str) -> dict | None:
    """Last-resort extraction when all JSON parsing fails.
    Finds path and content by string manipulation rather than JSON parsing."""
    for path_marker in ('"path": "', '"path":"'):
        pi = text.find(path_marker)
        if pi != -1:
            ps = pi + len(path_marker)
            pe = text.find('"', ps)
            path = text[ps:pe] if pe != -1 else None
            break
    else:
        path = None

    for content_marker in ('"content": "', '"content":"'):
        ci = text.find(content_marker)
        if ci != -1:
            content_start = ci + len(content_marker)
            break
    else:
        return None

    # Find the last `"}` or trailing `"` as the content boundary
    end = text.rfind('"}')
    if end == -1 or end <= content_start:
        end = text.rfind('"')
    if end <= content_start:
        return None

    content = text[content_start:end]
    content = content.replace('\\"', '"')
    content = content.replace("\\n", "\n")
    content = content.replace("\\t", "\t")
    content = content.replace("\\r", "")
    return {"path": path, "content": content}


def _strip_think_and_parse(text: str) -> dict:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    text = re.sub(r"```json\s*|```\s*", "", text).strip()

    # Strategy 1: direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strategy 2: normalize \\" → \" (Claude double-escaping HTML attribute quotes)
    normed = _normalize_escaped_quotes(text)
    if normed != text:
        try:
            return json.loads(normed)
        except json.JSONDecodeError:
            pass

    # Strategy 3: string-aware brace extraction — handles { } inside string values
    for src in (text, normed):
        start       = src.find("{")
        if start == -1:
            continue
        i           = start
        depth       = 0
        in_string   = False
        escape_next = False
        candidate   = None
        while i < len(src):
            ch = src[i]
            if escape_next:
                escape_next = False
            elif ch == "\\" and in_string:
                escape_next = True
            elif ch == '"':
                in_string = not in_string
            elif not in_string:
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        candidate = src[start : i + 1]
                        try:
                            return json.loads(candidate)
                        except json.JSONDecodeError:
                            pass
                        nxt = src.find("{", i + 1)
                        if nxt == -1:
                            break
                        start, i, in_string, escape_next = nxt, nxt, False, False
                        depth = 0
                        continue
            i += 1

        # Strategy 4: repair literal control chars, then re-parse
        for s in ([candidate] if candidate else []) + [src]:
            if s is None:
                continue
            try:
                return json.loads(_repair_json_strings(s))
            except json.JSONDecodeError:
                pass

    # Strategy 5: regex widest span + repair
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        for s in (m.group(), _normalize_escaped_quotes(m.group()),
                  _repair_json_strings(m.group())):
            try:
                return json.loads(s)
            except json.JSONDecodeError:
                pass

    # Strategy 6: content fallback — pure string extraction
    result = _extract_content_fallback(text)
    if result and result.get("content"):
        return result

    raise ValueError(f"No valid JSON object found: {text[:300]}")


def _parse_delimited_files(text: str) -> list:
    """Parse ===FILE: path===...===ENDFILE=== blocks from Claude's update-mode response."""
    results = []
    pattern = re.compile(r"===FILE:\s*([^\n]+)===\s*\n(.*?)===ENDFILE===", re.DOTALL)
    for m in pattern.finditer(text):
        path    = m.group(1).strip()
        content = m.group(2)
        # Trim a single trailing newline that the delimiter format naturally produces
        if content.endswith("\n"):
            content = content[:-1]
        results.append({"path": path, "content": content})
    return results


# ── Subprocess helper ─────────────────────────────────────────────────────────

async def _run_cmd(cmd: list, cwd: Optional[str] = None) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode, stdout.decode(errors="replace"), stderr.decode(errors="replace")


# ── Build failure helper ──────────────────────────────────────────────────────

def _fail_retryable(job_id: str, job: dict, step: str, error: str) -> None:
    """Reset job to approved/null so it can be retried without manual intervention."""
    job_path   = INTAKE_JOBS_DIR / f"{job_id}.json"
    index_path = INTAKE_JOBS_DIR / "index.jsonl"
    build_fail_log.error(
        "BUILD_FAILED job_id=%s step=%s error=%s | writing job=%s index=%s",
        job_id, step, error[:300], job_path, index_path,
    )
    job["build_status"] = None
    try:
        job_path.write_text(json.dumps(job, indent=2, default=str), encoding="utf-8")
        build_fail_log.info("BUILD_RESET job_id=%s build_status=null written to %s", job_id, job_path)
    except Exception as we:
        build_fail_log.error("BUILD_RESET_WRITE_FAILED job_id=%s path=%s error=%s", job_id, job_path, we)
    updated = _update_index_entry(job_id, {"status": "approved"})
    if updated:
        build_fail_log.info("BUILD_RESET job_id=%s index status=approved written to %s", job_id, index_path)
    else:
        build_fail_log.error("BUILD_RESET_INDEX_FAILED job_id=%s index not updated (entry not found?)", job_id)


# ── Package specs ─────────────────────────────────────────────────────────────

_PKG = {
    "standard": {"max_pages": 7,  "support": "30", "label": "Standard Launchpad",  "premium": False},
    "premium":  {"max_pages": 15, "support": "90", "label": "Premium Full Build",   "premium": True},
}


def _pkg(name: Optional[str]) -> dict:
    return _PKG.get((name or "standard").lower(), _PKG["standard"])


def extract_dominant_colors(logo_base64: str, n: int = 5) -> list:
    """Extract up to n dominant hex colors from a logo. Accepts raw base64 or data URI."""
    if not _PILLOW_OK or not logo_base64:
        return []
    try:
        if logo_base64.startswith("data:"):
            logo_base64 = logo_base64.split(",", 1)[1]
        img = _PILImage.open(io.BytesIO(base64.b64decode(logo_base64))).convert("RGB")
        img.thumbnail((150, 150))
        buckets = [(r // 32 * 32, g // 32 * 32, b // 32 * 32) for r, g, b in img.getdata()]
        top = [
            color for color, _ in Counter(buckets).most_common(20)
            if not (all(c > 230 for c in color) or all(c < 25 for c in color))
        ]
        return [f"#{r:02x}{g:02x}{b:02x}" for r, g, b in top[:n]]
    except Exception:
        return []


def resolve_logo(job: dict) -> str:
    """Return logo base64. Checks brief first, then searches change requests by filename.
    If found in change requests, persists to original_brief.brand so future builds keep it."""
    logo_b64 = (
        job.get("original_brief", {})
           .get("brand", {})
           .get("logo_base64", "") or ""
    )
    if logo_b64:
        return logo_b64

    for cr in job.get("change_requests", []):
        for img in (cr.get("images") or []):
            fname = (img.get("filename") or "").lower()
            if any(x in fname for x in ["logo", "brand", "icon"]):
                b64 = img.get("base64") or ""
                if b64:
                    brief = job.setdefault("original_brief", {})
                    brand = brief.setdefault("brand", {})
                    ct    = img.get("content_type") or "image/png"
                    brand["logo_base64"]        = b64
                    brand["logo_content_type"]  = ct
                    brand["logo_data_uri"]       = f"data:{ct};base64,{b64}"
                    colors = extract_dominant_colors(b64)
                    if colors:
                        brand["logo_dominant_colors"] = colors
                    return b64
    return ""


def detect_theme(brief, logo_colors: list) -> str:
    """Return 'dark' or 'light' based on brief keywords and logo color brightness."""
    if isinstance(brief, dict):
        notes = (brief.get("notes") or "").lower()
        goal  = (brief.get("project", {}).get("goal") or "").lower()
        tone  = brief.get("project", {}).get("tone") or []
        if isinstance(tone, str):
            tone = [tone]
        brief_text = f"{notes} {goal} {' '.join(tone)}"
    else:
        brief_text = (brief or "").lower()
    dark_kw  = {"dark", "black", "bold", "dramatic", "edgy", "industrial", "night", "sleek", "luxury"}
    light_kw = {"light", "clean", "minimal", "bright", "fresh", "airy", "pastel", "white", "soft"}
    lower = brief_text.lower()
    dark_score  = sum(1 for w in dark_kw  if w in lower)
    light_score = sum(1 for w in light_kw if w in lower)
    if logo_colors:
        brightnesses = []
        for hc in logo_colors:
            hc = hc.lstrip("#")
            if len(hc) == 6:
                r, g, b = int(hc[0:2], 16), int(hc[2:4], 16), int(hc[4:6], 16)
                brightnesses.append(0.299 * r + 0.587 * g + 0.114 * b)
        if brightnesses:
            avg = sum(brightnesses) / len(brightnesses)
            if avg > 180:
                light_score += 1
            elif avg < 80:
                dark_score += 1
    return "light" if light_score > dark_score else "dark"


# ── Stock image helpers ───────────────────────────────────────────────────────

INDUSTRY_KEYWORDS: dict = {
    "landscaping":  ["landscaping", "garden", "lawn", "outdoor-living", "hardscape", "xeriscape", "backyard", "patio"],
    "bakery":       ["bakery", "bread", "pastry", "coffee", "cafe", "baking"],
    "restaurant":   ["restaurant", "food", "dining", "kitchen", "cuisine"],
    "construction": ["construction", "building", "architecture", "contractor"],
    "cleaning":     ["cleaning", "home-cleaning", "professional-cleaning"],
    "plumbing":     ["plumbing", "pipes", "home-repair"],
    "electrical":   ["electrical", "contractor", "wiring"],
    "roofing":      ["roofing", "house-exterior", "roof"],
    "painting":     ["painting", "home-renovation", "interior-design"],
    "real estate":  ["real-estate", "house", "property", "home"],
    "fitness":      ["fitness", "gym", "workout", "exercise"],
    "salon":        ["salon", "beauty", "hair", "spa"],
    "dental":       ["dental", "clinic", "medical", "teeth"],
    "legal":        ["law", "office", "professional", "attorney"],
    "accounting":   ["accounting", "finance", "office", "business"],
    "photography":  ["photography", "camera", "studio", "portrait"],
    "auto":         ["automotive", "car", "mechanic", "garage"],
    "pet":          ["pets", "dog", "veterinary", "animal"],
    "childcare":    ["childcare", "kids", "education", "learning"],
    "default":      ["business", "professional", "office", "team"],
}

STOCK_MIN_SIZES: dict[str, tuple[int, int]] = {
    "hero":      (1920, 1080), "hero_alt":  (1920, 1080), "cta":       (1920, 1080),
    "gallery_1": (800,  600),  "gallery_2": (800,  600),  "gallery_3": (800,  600),
    "gallery_4": (800,  600),  "gallery_5": (800,  600),  "gallery_6": (800,  600),
    "service_1": (600,  400),  "service_2": (600,  400),  "service_3": (600,  400),
    "about":     (800,  500),
}


def get_stock_images(industry: str, count: int = 8) -> dict:
    industry_lower = (industry or "").lower()
    keywords = INDUSTRY_KEYWORDS["default"]
    for key in INDUSTRY_KEYWORDS:
        if key in industry_lower or industry_lower in key:
            keywords = INDUSTRY_KEYWORDS[key]
            break
    while len(keywords) < count:
        keywords = keywords + keywords
    keywords = keywords[:count]
    return {
        "hero":      f"https://picsum.photos/seed/{keywords[0]}/1920/1080",
        "hero_alt":  f"https://picsum.photos/seed/{keywords[1]}/1920/1080",
        "gallery_1": f"https://picsum.photos/seed/{keywords[0]}/800/600",
        "gallery_2": f"https://picsum.photos/seed/{keywords[1]}/800/600",
        "gallery_3": f"https://picsum.photos/seed/{keywords[2]}/800/600",
        "gallery_4": f"https://picsum.photos/seed/{keywords[3]}/800/600",
        "gallery_5": f"https://picsum.photos/seed/{keywords[4]}/800/600",
        "gallery_6": f"https://picsum.photos/seed/{keywords[5]}/800/600",
        "service_1": f"https://picsum.photos/seed/{keywords[0]}/600/400",
        "service_2": f"https://picsum.photos/seed/{keywords[1]}/600/400",
        "service_3": f"https://picsum.photos/seed/{keywords[2]}/600/400",
        "about":     f"https://picsum.photos/seed/{keywords[6]}/800/500",
        "cta":       f"https://picsum.photos/seed/{keywords[7]}/1200/600",
    }


# ── Gallery admin helpers ─────────────────────────────────────────────────────

def _needs_gallery_admin(brief: dict, change_requests: list) -> bool:
    triggers = {"admin", "gallery admin", "manage gallery", "upload photos", "manage photos", "photo upload"}
    texts = [
        (brief.get("notes") or "").lower(),
        (brief.get("project", {}).get("goal") or "").lower(),
    ]
    for cr in change_requests:
        texts.append((cr.get("notes") or "").lower())
    combined = " ".join(texts)
    return any(t in combined for t in triggers)


def _extract_admin_password(change_requests: list) -> str:
    for cr in change_requests:
        notes = cr.get("notes") or ""
        m = re.search(r"password[:\s]+([A-Za-z0-9!@#$%^&*_\-\.]{6,})", notes, re.IGNORECASE)
        if m:
            return m.group(1)
    return "Admin2026!"


def _make_gallery_admin_html(
    job_id: str,
    business_name: str,
    password: str,
    primary_color: str,
    stock_images: dict,
    admin_token: str = "",
) -> str:
    site_url = f"/{job_id}/"
    api_base = "https://builder.funkfactorymediagroup.com"
    preview  = "https://preview.funkfactorymediagroup.com"

    # Use a plain string + replace() to avoid f-string brace escaping issues with JS
    html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gallery Admin — BUSINESS_NAME</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--primary:PRIMARY_COLOR;--bg:#f8f9fa;--white:#fff;--text:#1a1a1a;--muted:#666;--border:#e0e0e0;--red:#c0392b;--green:#27ae60}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
  #login-screen{display:flex;align-items:center;justify-content:center;min-height:100vh}
  .login-box{background:var(--white);border-radius:12px;padding:40px;width:340px;box-shadow:0 4px 24px rgba(0,0,0,.1)}
  .login-box h1{font-size:20px;color:var(--text);margin-bottom:4px}
  .login-box p{font-size:13px;color:var(--muted);margin-bottom:24px}
  .login-box input{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none;margin-bottom:12px}
  .login-box input:focus{border-color:var(--primary)}
  .login-box button{width:100%;padding:11px;background:var(--primary);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
  .login-box button:hover{opacity:.9}
  .login-err{color:var(--red);font-size:13px;margin-top:8px;min-height:18px}
  #app{display:none}
  .topbar{background:var(--primary);color:#fff;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
  .topbar h1{font-size:18px;font-weight:700}
  .back-link{color:rgba(255,255,255,.8);font-size:13px;text-decoration:none}
  .back-link:hover{color:#fff}
  .content{max-width:1100px;margin:0 auto;padding:28px 24px}
  .btn{display:inline-flex;align-items:center;justify-content:center;padding:9px 18px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}
  .btn:hover{opacity:.85}
  .btn-primary{background:var(--primary);color:#fff}
  .btn-danger{background:var(--red);color:#fff}
  .btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
  .btn-sm{padding:5px 12px;font-size:12px}
  .projects-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
  .projects-header h2{font-size:18px;font-weight:700}
  .projects-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px}
  .project-card{background:var(--white);border:1px solid var(--border);border-radius:10px;overflow:hidden}
  .project-photos{display:grid;grid-template-columns:1fr 1fr;gap:2px;background:var(--border)}
  .project-photos img{width:100%;height:130px;object-fit:cover;display:block}
  .photo-placeholder{width:100%;height:130px;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted)}
  .photo-label{font-size:10px;color:var(--muted);text-align:center;padding:2px 0;background:rgba(0,0,0,.04)}
  .project-body{padding:14px}
  .project-name{font-size:14px;font-weight:700;margin-bottom:4px}
  .project-desc{font-size:12px;color:var(--muted);margin-bottom:10px;line-height:1.4}
  .project-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
  .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
  .badge-completed{background:#d1fae5;color:#065f46}
  .badge-in_progress{background:#fef9c3;color:#92400e}
  .toggle-wrap{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
  .toggle{width:36px;height:20px;background:var(--border);border-radius:10px;position:relative;cursor:pointer;border:none;transition:background .15s;flex-shrink:0}
  .toggle.on{background:var(--green)}
  .toggle::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:left .15s}
  .toggle.on::after{left:18px}
  .project-actions{display:flex;gap:6px;margin-top:10px}
  .empty-state{text-align:center;padding:60px 20px;color:var(--muted)}
  .empty-icon{font-size:40px;margin-bottom:12px}
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;align-items:center;justify-content:center;padding:20px}
  .modal-overlay.open{display:flex}
  .modal{background:var(--white);border-radius:12px;padding:28px;width:100%;max-width:520px;max-height:90vh;overflow-y:auto}
  .modal h3{font-size:18px;font-weight:700;margin-bottom:20px}
  .field{margin-bottom:16px}
  .field label{display:block;font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}
  .field input,.field textarea,.field select{width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;outline:none}
  .field input:focus,.field textarea:focus,.field select:focus{border-color:var(--primary)}
  .field textarea{min-height:80px;resize:vertical}
  .photo-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .photo-preview{width:100%;height:120px;object-fit:cover;border-radius:6px;border:1px solid var(--border);display:none;margin-top:6px}
  .modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}
  .section-tabs{display:flex;gap:2px;margin-bottom:24px;background:var(--border);border-radius:10px;padding:3px}
  .section-tab{flex:1;padding:8px 16px;border:none;background:transparent;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;color:var(--muted);transition:all .15s}
  .section-tab.active{background:var(--white);color:var(--text);box-shadow:0 1px 4px rgba(0,0,0,.1)}
  .contact-section{display:none}
  .contact-section.visible{display:block}
  .stock-section{display:none}
  .stock-section.visible{display:block}
  .gallery-section.hidden{display:none}
  .contact-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .contact-save-bar{display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:20px}
  .save-feedback{font-size:13px;color:var(--green);opacity:0;transition:opacity .3s}
  .save-feedback.show{opacity:1}
  .stock-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-bottom:20px}
  .stock-card{background:var(--white);border:1px solid var(--border);border-radius:10px;overflow:hidden}
  .stock-thumb{width:100%;height:140px;object-fit:cover;display:block;background:#f0f0f0}
  .stock-body{padding:12px}
  .stock-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text);margin-bottom:6px}
  .stock-min{font-size:11px;color:var(--muted);margin-top:3px}
  .stock-thumb-wrap{width:100%;height:140px;background:#1a1a1a;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}
  .stock-thumb{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
  .stock-no-img{font-size:11px;color:#555;pointer-events:none;z-index:1}
  .stock-card-actions{display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--border)}
  .media-section{display:none}.media-section.visible{display:block}
  .media-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:16px}
  .media-item{border-radius:8px;overflow:hidden;background:#1a1a1a}
  .media-item img{width:100%;height:110px;object-fit:cover;display:block}
  .media-item-label{font-size:11px;font-weight:600;padding:4px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .media-item-badge{font-size:10px;color:var(--muted);padding:0 8px 6px}
  .picker-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:300;align-items:center;justify-content:center;padding:20px}
  .picker-overlay.open{display:flex}
  .picker-modal{background:var(--white);border-radius:12px;padding:24px;width:100%;max-width:680px;max-height:85vh;display:flex;flex-direction:column;gap:16px}
  .picker-header{display:flex;align-items:center;justify-content:space-between}
  .picker-header h3{font-size:16px;font-weight:700}
  .picker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;overflow-y:auto;max-height:50vh}
  .picker-item{border-radius:8px;overflow:hidden;background:#1a1a1a;cursor:pointer;border:2px solid transparent;transition:border-color .15s}
  .picker-item:hover{border-color:var(--primary)}
  .picker-item img{width:100%;height:90px;object-fit:cover;display:block}
  .picker-item span{display:block;font-size:10px;padding:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}
  .existing-photos{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .existing-thumb{width:70px;height:70px;object-fit:cover;border-radius:6px;border:2px solid var(--border);display:block}
  @media(max-width:600px){.projects-grid,.photo-grid,.contact-form-grid,.stock-grid,.media-grid{grid-template-columns:1fr}}
</style>
</head>
<body>

<div id="login-screen">
  <div class="login-box">
    <h1>Gallery Admin</h1>
    <p>BUSINESS_NAME</p>
    <input type="password" id="pw" placeholder="Password" autocomplete="current-password">
    <button onclick="doLogin()">Sign In</button>
    <div class="login-err" id="login-err"></div>
  </div>
</div>

<div id="app">
  <div class="topbar">
    <h1>Site Admin</h1>
    <div class="topbar-actions">
      <a href="SITE_URL" class="back-link">&larr; Back to Website</a>
    </div>
  </div>
  <div class="content">
    <div class="section-tabs">
      <button class="section-tab active" onclick="showSection('gallery')">Gallery Projects</button>
      <button class="section-tab" onclick="showSection('contact')">Contact &amp; Socials</button>
      <button class="section-tab" onclick="showSection('stock')">Stock Images</button>
      <button class="section-tab" onclick="showSection('media')">Media</button>
    </div>
    <div class="gallery-section">
      <div class="projects-header">
        <h2>Projects</h2>
        <button class="btn btn-primary" onclick="openAddModal()">+ Add Project</button>
      </div>
      <div class="projects-grid" id="projects-grid"></div>
    </div>
    <div class="contact-section" id="contact-section">
      <div class="projects-header"><h2>Contact &amp; Socials</h2></div>
      <div class="contact-form-grid">
        <div class="field"><label>Phone</label><input type="tel" id="c-phone" placeholder="(505) 555-1234"></div>
        <div class="field"><label>Email</label><input type="email" id="c-email" placeholder="info@example.com"></div>
        <div class="field" style="grid-column:1/-1"><label>Address</label><input type="text" id="c-address" placeholder="123 Main St, City, NM 87124"></div>
        <div class="field"><label>Facebook URL</label><input type="url" id="c-facebook" placeholder="https://facebook.com/..."></div>
        <div class="field"><label>Instagram URL</label><input type="url" id="c-instagram" placeholder="https://instagram.com/..."></div>
        <div class="field"><label>Google Business URL</label><input type="url" id="c-google" placeholder="https://g.page/..."></div>
        <div class="field"><label>Yelp URL</label><input type="url" id="c-yelp" placeholder="https://yelp.com/biz/..."></div>
        <div class="field"><label>TikTok URL</label><input type="url" id="c-tiktok" placeholder="https://tiktok.com/@..."></div>
      </div>
      <div class="contact-save-bar">
        <span class="save-feedback" id="contact-saved-msg">Saved!</span>
        <button class="btn btn-primary" onclick="saveContact()">Save Changes</button>
      </div>
    </div>
    <div class="stock-section" id="stock-section">
      <div class="projects-header"><h2>Stock Images</h2></div>
      <p style="font-size:13px;color:var(--muted);margin-bottom:20px">Override the default stock photos used across your website. Changes apply live on every page.</p>
      <div class="stock-grid" id="stock-grid"></div>
      <div class="contact-save-bar">
        <span class="save-feedback" id="stock-saved-msg">Saved!</span>
        <button class="btn btn-primary" onclick="saveStockImages()">Save All Images</button>
      </div>
    </div>
    <div class="media-section" id="media-section">
      <div class="projects-header"><h2>All Media</h2></div>
      <p style="font-size:13px;color:var(--muted);margin-bottom:8px">Photos uploaded across all projects.</p>
      <div class="media-grid" id="media-grid"></div>
    </div>
  </div>
</div>

<div class="picker-overlay" id="picker-modal">
  <div class="picker-modal">
    <div class="picker-header">
      <h3>Choose Existing Image</h3>
      <button class="btn btn-ghost btn-sm" onclick="closePicker()">&#10005; Close</button>
    </div>
    <p style="font-size:12px;color:var(--muted)">Click an image to assign it to the selected slot.</p>
    <div class="picker-grid" id="picker-grid"></div>
  </div>
</div>

<div class="modal-overlay" id="add-modal">
  <div class="modal">
    <h3 id="modal-title">Add New Project</h3>
    <div class="field"><label>Project Name *</label><input type="text" id="m-name" placeholder="e.g. Backyard Renovation"></div>
    <div class="field"><label>Description</label><textarea id="m-desc" placeholder="Brief description..."></textarea></div>
    <div class="field"><label>Status</label>
      <select id="m-status"><option value="completed">Completed</option><option value="in_progress">In Progress</option></select>
    </div>
    <div class="photo-grid">
      <div class="field"><label>Before Photo</label>
        <input type="file" id="m-before-file" accept="image/jpeg,image/png,image/webp" onchange="loadPhoto(this,'before','m-before-preview')">
        <img class="photo-preview" id="m-before-preview">
      </div>
      <div class="field"><label>After Photo</label>
        <input type="file" id="m-after-file" accept="image/jpeg,image/png,image/webp" onchange="loadPhoto(this,'after','m-after-preview')">
        <img class="photo-preview" id="m-after-preview">
      </div>
    </div>
    <div class="field" id="existing-photos-field" style="display:none">
      <label>Existing Photos</label>
      <div class="existing-photos" id="existing-photos-strip"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveProject()">Save Project</button>
    </div>
  </div>
</div>

<script>
var PASS        = PASS_PLACEHOLDER;
var API         = 'API_BASE_PLACEHOLDER';
var JOB         = 'JOB_ID_PLACEHOLDER';
var PREVIEW     = 'PREVIEW_PLACEHOLDER';
var TOKEN       = 'TOKEN_PLACEHOLDER';
var CONTACT_KEY = 'CONTACT_KEY_PLACEHOLDER';
var STOCK_KEY   = 'STOCK_KEY_PLACEHOLDER';
var STOCK_DEFAULTS = STOCK_DEFAULTS_PLACEHOLDER;
var STOCK_MIN_SIZES = {
  hero:'1920\xd71080', hero_alt:'1920\xd71080', cta:'1920\xd71080',
  gallery_1:'800\xd7600', gallery_2:'800\xd7600', gallery_3:'800\xd7600',
  gallery_4:'800\xd7600', gallery_5:'800\xd7600', gallery_6:'800\xd7600',
  service_1:'600\xd7400', service_2:'600\xd7400', service_3:'600\xd7400',
  about:'800\xd7500'
};
var STOCK_LABELS = {
  hero:'Hero Image', hero_alt:'Hero (Alt)', cta:'CTA Banner',
  gallery_1:'Gallery 1', gallery_2:'Gallery 2', gallery_3:'Gallery 3',
  gallery_4:'Gallery 4', gallery_5:'Gallery 5', gallery_6:'Gallery 6',
  service_1:'Service 1', service_2:'Service 2', service_3:'Service 3',
  about:'About'
};
var STOCK_ORDER = ['hero','hero_alt','gallery_1','gallery_2','gallery_3','gallery_4','gallery_5','gallery_6','service_1','service_2','service_3','about','cta'];

// ── In-memory state ─────────────────────────────────────────────────────────
var _projects = [];       // fetched from server
var _serverImages = {};   // slot → absolute URL (from server images API)

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function absImg(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return PREVIEW + (url.startsWith('/') ? url : '/' + url);
}
function authHdr() { return {'X-Admin-Token': TOKEN, 'Content-Type': 'application/json'}; }

// ── Login ────────────────────────────────────────────────────────────────────
function doLogin() {
  if (document.getElementById('pw').value !== PASS) {
    document.getElementById('login-err').textContent = 'Incorrect password.'; return;
  }
  sessionStorage.setItem('gallery_admin_auth','1');
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  fetchProjects(); fetchServerImages(renderStockGrid);
}
document.getElementById('pw').addEventListener('keydown', function(e) { if (e.key==='Enter') doLogin(); });
if (sessionStorage.getItem('gallery_admin_auth') === '1') {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  fetchProjects(); fetchServerImages(renderStockGrid);
}

// ── Server API helpers ───────────────────────────────────────────────────────
function fetchProjects() {
  fetch(API+'/sites/'+JOB+'/projects')
    .then(function(r){return r.ok?r.json():null;})
    .then(function(data){ _projects=(data&&data.projects)||[]; renderProjects(); })
    .catch(function(){renderProjects();});
}

function pushProjects(cb) {
  fetch(API+'/sites/'+JOB+'/projects', {
    method:'POST', headers:authHdr(), body:JSON.stringify(_projects)
  }).then(function(){if(cb)cb();}).catch(function(){if(cb)cb();});
}

function fetchServerImages(cb) {
  fetch(API+'/sites/'+JOB+'/images', {headers:{'X-Admin-Token':TOKEN}})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(data){
      _serverImages={};
      if(data&&data.images){
        Object.keys(data.images).forEach(function(slot){
          var raw=data.images[slot]; if(raw) _serverImages[slot]=absImg(raw);
        });
      }
      if(cb)cb();
    })
    .catch(function(){if(cb)cb();});
}

function uploadSiteImage(slot, file, cb) {
  var fd=new FormData(); fd.append('slot',slot); fd.append('file',file);
  fetch(API+'/sites/'+JOB+'/images', {method:'POST', headers:{'X-Admin-Token':TOKEN}, body:fd})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(data){
      if(data&&data.url) _serverImages[slot]=absImg(data.url)+'?_v='+Date.now();
      if(cb)cb();
    })
    .catch(function(){if(cb)cb();});
}

// ── Projects ─────────────────────────────────────────────────────────────────
function _projectCover(p) {
  var media=p.media||[];
  var idx=p.cover_index!==undefined?p.cover_index:0;
  var sel=media[idx];
  if(sel&&sel.type==='image'){var u=sel.data||sel.url||'';if(u)return absImg(u);}
  for(var i=0;i<media.length;i++){var u2=media[i].type==='image'&&(media[i].data||media[i].url||'');if(u2)return absImg(u2);}
  if(p.before_photo)return absImg(p.before_photo);
  if(p.after_photo)return absImg(p.after_photo);
  return '';
}

function renderProjects() {
  var grid=document.getElementById('projects-grid');
  if(!_projects.length){
    grid.innerHTML='<div class="empty-state"><div class="empty-icon">&#128444;</div><p>No projects yet &mdash; click Add Project to get started.</p></div>';
    return;
  }
  grid.innerHTML=_projects.map(function(p,i){
    var cover=_projectCover(p);
    return '<div class="project-card">'
      +'<div class="project-photos"><div><div class="photo-label">Cover</div>'
      +(cover?'<img src="'+esc(cover)+'" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
             :'<div class="photo-placeholder">No photo</div>')
      +'</div><div><div class="photo-label">'+(esc(p.category||p.location||''))+'</div>'
      +'<div class="photo-placeholder" style="font-size:11px;padding:8px">'+esc(p.name||p.title||'')+'</div>'
      +'</div></div>'
      +'<div class="project-body"><div class="project-name">'+esc(p.name||p.title||'')+'</div>'
      +'<div class="project-desc">'+esc(p.description||'')+'</div>'
      +'<div class="project-meta">'
      +'<span class="badge badge-'+(p.status||'completed')+'">'+(p.status||'completed').replace('_',' ')+'</span>'
      +'<div class="toggle-wrap"><button class="toggle '+(p.visible!==false?'on':'')
      +'" onclick="toggleVisible('+i+')" title="Toggle visibility"></button>'
      +'<span>'+(p.visible!==false?'Visible':'Hidden')+'</span></div></div>'
      +'<div class="project-actions">'
      +'<button class="btn btn-ghost btn-sm" onclick="editProject('+i+')">Edit</button>'
      +'<button class="btn btn-danger btn-sm" onclick="deleteProject('+i+')">Delete</button>'
      +'</div></div></div>';
  }).join('');
}

function toggleVisible(i) {
  _projects[i].visible=_projects[i].visible===false;
  pushProjects(renderProjects);
}
function deleteProject(i) {
  if(!confirm('Delete this project?'))return;
  _projects.splice(i,1); pushProjects(renderProjects);
}

// ── Add/Edit modal ───────────────────────────────────────────────────────────
var _editIdx=-1, _beforeB64='', _afterB64='';

function openAddModal() {
  _editIdx=-1; _beforeB64=''; _afterB64='';
  document.getElementById('modal-title').textContent='Add New Project';
  document.getElementById('m-name').value='';
  document.getElementById('m-desc').value='';
  document.getElementById('m-status').value='completed';
  document.getElementById('m-before-file').value='';
  document.getElementById('m-after-file').value='';
  document.getElementById('m-before-preview').style.display='none';
  document.getElementById('m-after-preview').style.display='none';
  document.getElementById('existing-photos-field').style.display='none';
  document.getElementById('add-modal').classList.add('open');
}

function editProject(i) {
  var p=_projects[i]; _editIdx=i;
  _beforeB64=p.before_photo||''; _afterB64=p.after_photo||'';
  document.getElementById('modal-title').textContent='Edit Project';
  document.getElementById('m-name').value=p.name||p.title||'';
  document.getElementById('m-desc').value=p.description||'';
  document.getElementById('m-status').value=p.status||'completed';
  document.getElementById('m-before-file').value='';
  document.getElementById('m-after-file').value='';
  var bp=document.getElementById('m-before-preview'), ap=document.getElementById('m-after-preview');
  if(_beforeB64){bp.src=absImg(_beforeB64);bp.style.display='block';}else{bp.style.display='none';}
  if(_afterB64){ap.src=absImg(_afterB64);ap.style.display='block';}else{ap.style.display='none';}
  // Existing photos strip — all media images for this project
  var allPhotos=[];
  if(p.before_photo) allPhotos.push(absImg(p.before_photo));
  if(p.after_photo)  allPhotos.push(absImg(p.after_photo));
  (p.media||[]).forEach(function(m){
    var u=(m.type==='image')&&(m.data||m.url||''); if(u) allPhotos.push(absImg(u));
  });
  var strip=document.getElementById('existing-photos-strip');
  var field=document.getElementById('existing-photos-field');
  if(allPhotos.length){
    strip.innerHTML=allPhotos.map(function(src){
      return '<img class="existing-thumb" src="'+esc(src)+'" loading="lazy" onerror="this.style.display=\'none\'">';
    }).join('');
    field.style.display='block';
  } else { field.style.display='none'; }
  document.getElementById('add-modal').classList.add('open');
}

function closeModal() { document.getElementById('add-modal').classList.remove('open'); }

function loadPhoto(input, side, previewId) {
  var file=input.files[0]; if(!file) return;
  var reader=new FileReader();
  reader.onload=function(e){
    if(side==='before') _beforeB64=e.target.result; else _afterB64=e.target.result;
    var el=document.getElementById(previewId); el.src=e.target.result; el.style.display='block';
  };
  reader.readAsDataURL(file);
}

function saveProject() {
  var name=document.getElementById('m-name').value.trim();
  if(!name){alert('Project name is required.');return;}
  var base=_editIdx>=0?_projects[_editIdx]:{};
  var entry={
    id: _editIdx>=0?(base.id||genId()):genId(),
    name:name, description:document.getElementById('m-desc').value.trim(),
    status:document.getElementById('m-status').value, visible:true,
    before_photo:_beforeB64, after_photo:_afterB64,
    media: base.media||[],
    created_at:_editIdx>=0?(base.created_at||new Date().toISOString()):new Date().toISOString()
  };
  if(_editIdx>=0) _projects[_editIdx]=entry; else _projects.push(entry);
  pushProjects(function(){closeModal();renderProjects();});
}

document.getElementById('add-modal').addEventListener('click',function(e){if(e.target===this)closeModal();});

// ── Section tabs ─────────────────────────────────────────────────────────────
function showSection(s) {
  var tabs=document.querySelectorAll('.section-tab');
  tabs[0].classList.toggle('active',s==='gallery');
  tabs[1].classList.toggle('active',s==='contact');
  tabs[2].classList.toggle('active',s==='stock');
  tabs[3].classList.toggle('active',s==='media');
  document.querySelector('.gallery-section').classList.toggle('hidden',s!=='gallery');
  document.getElementById('contact-section').classList.toggle('visible',s==='contact');
  document.getElementById('stock-section').classList.toggle('visible',s==='stock');
  document.getElementById('media-section').classList.toggle('visible',s==='media');
  if(s==='media') renderMediaTab();
  if(s==='stock') fetchServerImages(renderStockGrid);
}

// ── Contact (localStorage — no server endpoint needed) ────────────────────────
function loadContact() {
  try { return JSON.parse(localStorage.getItem(CONTACT_KEY)||'{}'); } catch(_) { return {}; }
}
function saveContact() {
  var c={
    phone:document.getElementById('c-phone').value.trim(),
    email:document.getElementById('c-email').value.trim(),
    address:document.getElementById('c-address').value.trim(),
    facebook:document.getElementById('c-facebook').value.trim(),
    instagram:document.getElementById('c-instagram').value.trim(),
    google:document.getElementById('c-google').value.trim(),
    yelp:document.getElementById('c-yelp').value.trim(),
    tiktok:document.getElementById('c-tiktok').value.trim()
  };
  localStorage.setItem(CONTACT_KEY,JSON.stringify(c));
  var msg=document.getElementById('contact-saved-msg');
  msg.classList.add('show'); setTimeout(function(){msg.classList.remove('show');},2000);
}

// ── Stock Images — server-uploaded files + URL overrides ─────────────────────
function loadStockImages() {
  try { return JSON.parse(localStorage.getItem(STOCK_KEY)||'{}'); } catch(_) { return {}; }
}
function renderStockGrid() {
  var saved=loadStockImages();
  var grid=document.getElementById('stock-grid');
  if(!grid)return;
  grid.innerHTML=STOCK_ORDER.map(function(slot){
    // Server image takes precedence over localStorage URL override over picsum default
    var url=_serverImages[slot]||saved[slot]||STOCK_DEFAULTS[slot]||'';
    var isServer=!!_serverImages[slot];
    return '<div class="stock-card">'
      +'<div class="stock-thumb-wrap">'
      +(url?'<img class="stock-thumb" id="sthumb-'+slot+'" src="'+esc(url)+'" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
           :'<img class="stock-thumb" id="sthumb-'+slot+'" style="display:none" alt="">')
      +(!url?'<span class="stock-no-img">No image set</span>':'')
      +(isServer?'<span style="position:absolute;top:4px;left:4px;background:rgba(0,128,0,.8);color:#fff;font-size:9px;padding:2px 5px;border-radius:3px">UPLOADED</span>':'')
      +'</div><div class="stock-body">'
      +'<div class="stock-label">'+esc(STOCK_LABELS[slot]||slot)+'</div>'
      +'<div class="field" style="margin:6px 0 2px"><input type="file" accept="image/*" id="sfile-'+slot+'" onchange="uploadStockSlot(\''+slot+'\')" style="font-size:11px"></div>'
      +'<div class="field" style="margin:2px 0 4px"><input type="url" id="surl-'+slot+'" data-slot="'+slot+'" value="'+esc(isServer?'':( saved[slot]||''))+'" placeholder="Or paste URL..." oninput="updateThumb(this.dataset.slot)"></div>'
      +'<div class="stock-min">Min: '+(STOCK_MIN_SIZES[slot]||'')+'</div>'
      +'</div><div class="stock-card-actions">'
      +'<button class="btn btn-ghost btn-sm" onclick="openPicker(\''+slot+'\')">&#128193; Choose Existing</button>'
      +'</div></div>';
  }).join('');
}
function uploadStockSlot(slot) {
  var fileEl=document.getElementById('sfile-'+slot);
  var file=fileEl&&fileEl.files&&fileEl.files[0];
  if(!file)return;
  uploadSiteImage(slot, file, function(){
    renderStockGrid();
  });
}
function updateThumb(slot) {
  var url=(document.getElementById('surl-'+slot)||{}).value||'';
  var thumb=document.getElementById('sthumb-'+slot);
  if(!thumb)return;
  if(url){thumb.src=url;thumb.style.display='block';}else{thumb.style.display='none';}
}
function saveStockImages() {
  var saved={};
  STOCK_ORDER.forEach(function(slot){
    var el=document.getElementById('surl-'+slot);
    if(el&&el.value.trim()) saved[slot]=el.value.trim();
  });
  localStorage.setItem(STOCK_KEY,JSON.stringify(saved));
  var msg=document.getElementById('stock-saved-msg');
  msg.classList.add('show'); setTimeout(function(){msg.classList.remove('show');},2000);
}

// ── Image picker ─────────────────────────────────────────────────────────────
var _pickerSlot='', _pickerItems=[];
function openPicker(slot) {
  _pickerSlot=slot; _pickerItems=[];
  // Server-uploaded site images
  Object.keys(_serverImages).forEach(function(s){
    _pickerItems.push({src:_serverImages[s],label:'Site: '+esc(STOCK_LABELS[s]||s)});
  });
  // Project media
  _projects.forEach(function(p){
    if(p.before_photo) _pickerItems.push({src:absImg(p.before_photo),label:esc(p.name)+' (Before)'});
    if(p.after_photo)  _pickerItems.push({src:absImg(p.after_photo), label:esc(p.name)+' (After)'});
    (p.media||[]).forEach(function(m,mi){
      var u=(m.type==='image')&&(m.data||m.url||''); if(u) _pickerItems.push({src:absImg(u),label:esc(p.name)+' #'+(mi+1)});
    });
  });
  // localStorage URL overrides
  var saved=loadStockImages();
  STOCK_ORDER.forEach(function(s){if(s!==slot&&saved[s]) _pickerItems.push({src:saved[s],label:'Stock: '+esc(STOCK_LABELS[s]||s)});});
  var grid=document.getElementById('picker-grid');
  if(!_pickerItems.length){
    grid.innerHTML='<p style="color:var(--muted);padding:20px;grid-column:1/-1">No uploaded images found. Add photos to projects first.</p>';
  } else {
    grid.innerHTML=_pickerItems.map(function(img,i){
      return '<div class="picker-item" data-idx="'+i+'">'
        +'<img src="'+esc(img.src)+'" alt="" loading="lazy" onerror="this.parentElement.style.display=\'none\'">'
        +'<span>'+img.label+'</span>'
        +'</div>';
    }).join('');
    grid.onclick=function(e){
      var item=e.target.closest('.picker-item');
      if(item){var idx=parseInt(item.dataset.idx);if(_pickerItems[idx])selectFromPicker(_pickerItems[idx].src);}
    };
  }
  document.getElementById('picker-modal').classList.add('open');
}
function closePicker() { document.getElementById('picker-modal').classList.remove('open'); }
function selectFromPicker(src) {
  var inp=document.getElementById('surl-'+_pickerSlot);
  if(inp){inp.value=src;updateThumb(_pickerSlot);}
  closePicker();
}
document.getElementById('picker-modal').addEventListener('click',function(e){if(e.target===this)closePicker();});

// ── Media tab — all project media ─────────────────────────────────────────────
function renderMediaTab() {
  var grid=document.getElementById('media-grid');
  var items=[];
  _projects.forEach(function(p){
    if(p.before_photo) items.push({src:absImg(p.before_photo),label:p.name||'',badge:'Before',type:'image'});
    if(p.after_photo)  items.push({src:absImg(p.after_photo), label:p.name||'',badge:'After',type:'image'});
    (p.media||[]).forEach(function(m,mi){
      var u=m.data||m.url||'';
      if(!u)return;
      var abs=absImg(u);
      if(m.type==='image') items.push({src:abs,label:p.name||'',badge:'Photo '+(mi+1),type:'image'});
      else if(m.type==='mp4') items.push({src:abs,label:p.name||'',badge:'Video '+(mi+1),type:'video'});
      else if(m.type==='youtube'||m.type==='vimeo'){
        var id=m.type==='youtube'?u.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/):u.match(/vimeo\.com\/(\d+)/);
        var thumb=id?'https://img.youtube.com/vi/'+id[1]+'/mqdefault.jpg':'';
        items.push({src:thumb||abs,label:p.name||'',badge:m.type.charAt(0).toUpperCase()+m.type.slice(1),type:'video'});
      }
    });
  });
  if(!items.length){
    grid.innerHTML='<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">&#128444;</div><p>No media uploaded yet.</p></div>';
    return;
  }
  grid.innerHTML=items.map(function(m){
    return '<div class="media-item">'
      +(m.type==='video'?'<div style="position:relative;width:100%;height:110px;background:#111"><img src="'+esc(m.src)+'" style="width:100%;height:100%;object-fit:cover" loading="lazy" onerror="this.style.display=\'none\'"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:24px;pointer-events:none">&#9654;</div></div>'
              :'<img src="'+esc(m.src)+'" alt="" loading="lazy" onerror="this.parentElement.style.display=\'none\'">')
      +'<div class="media-item-label">'+esc(m.label)+'</div>'
      +'<div class="media-item-badge">'+esc(m.badge)+'</div>'
      +'</div>';
  }).join('');
}

// ── Init ──────────────────────────────────────────────────────────────────────
(function(){
  var c=loadContact();
  document.getElementById('c-phone').value    =c.phone||'';
  document.getElementById('c-email').value    =c.email||'';
  document.getElementById('c-address').value  =c.address||'';
  document.getElementById('c-facebook').value =c.facebook||'';
  document.getElementById('c-instagram').value=c.instagram||'';
  document.getElementById('c-google').value   =c.google||'';
  document.getElementById('c-yelp').value     =c.yelp||'';
  document.getElementById('c-tiktok').value   =c.tiktok||'';
})();
</script>
</body>
</html>"""

    contact_key = f"{job_id}-contact"
    stock_key   = f"{job_id}-stock-images"
    return (html
        .replace("BUSINESS_NAME", business_name)
        .replace("PRIMARY_COLOR", primary_color)
        .replace("SITE_URL", site_url)
        .replace("CONTACT_KEY_PLACEHOLDER", contact_key)
        .replace("STOCK_KEY_PLACEHOLDER", stock_key)
        .replace("STOCK_DEFAULTS_PLACEHOLDER", json.dumps(stock_images))
        .replace("API_BASE_PLACEHOLDER", api_base)
        .replace("JOB_ID_PLACEHOLDER", job_id)
        .replace("PREVIEW_PLACEHOLDER", preview)
        .replace("TOKEN_PLACEHOLDER", admin_token)
        .replace("PASS_PLACEHOLDER", json.dumps(str(password))))


def _gallery_cms_script(job_id: str) -> str:
    """Script injected into gallery.html — fetches real projects from server API."""
    api_base = "https://builder.funkfactorymediagroup.com"
    preview_domain = "preview.funkfactorymediagroup.com"
    return f"""
<script>
(function() {{
  var API = '{api_base}';
  var JOB = '{job_id}';
  var PREVIEW = 'https://{preview_domain}';

  function esc(s) {{ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }}

  function absUrl(url) {{
    if (!url) return '';
    if (url.startsWith('http')) return url;
    return PREVIEW + url;
  }}

  function getProjectCover(p) {{
    var media = p.media || [];
    var idx = p.cover_index !== undefined ? p.cover_index : (p.coverIndex !== undefined ? p.coverIndex : 0);
    var sel = media[idx];
    if (sel && sel.type === 'image') {{ var u = sel.data || sel.url || ''; if (u) return absUrl(u); }}
    for (var i = 0; i < media.length; i++) {{
      var u2 = media[i].type === 'image' && (media[i].data || media[i].url || '');
      if (u2) return absUrl(u2);
    }}
    var photos = (p.photos || []).filter(function(s) {{ return s && !s.startsWith('data:video'); }});
    var ph = photos[p.coverIndex || 0] || photos[0] || '';
    return ph ? absUrl(ph) : '';
  }}

  function render(projects) {{
    projects = (projects || []).filter(function(p) {{ return p.visible !== false; }});

    var emptyHtml = '<div style="text-align:center;padding:80px 20px;color:#888;grid-column:1/-1">'
      + '<p style="font-size:1.2rem">&#128247; Check back soon &mdash; photos coming!</p>'
      + '<p style="margin-top:8px;font-size:0.95rem">Our team is putting the gallery together.</p>'
      + '</div>';

    var cardsHtml = projects.length ? projects.map(function(p) {{
      var cover = getProjectCover(p);
      var cat   = esc(p.category || p.cat || '');
      var name  = esc(p.name || p.title || '');
      var loc   = esc(p.location || p.sub || '');
      var desc  = esc(p.description || '');
      var coverHtml = cover
        ? '<div style="width:100%;height:220px;background:#1a1a1a url(' + esc(cover) + ') center/cover no-repeat"></div>'
        : '<div style="width:100%;height:220px;background:#1a1a1a"></div>';
      return '<div style="border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.15);background:#1e1e1e">'
        + coverHtml
        + '<div style="padding:14px">'
        + (cat ? '<span style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#c0392b;font-weight:600">' + cat + '</span><br>' : '')
        + '<strong style="display:block;margin:4px 0 2px;color:#fff">' + name + '</strong>'
        + (loc  ? '<span style="font-size:12px;color:#888">' + loc + '</span>' : '')
        + (desc ? '<p style="font-size:13px;color:#aaa;margin-top:6px">' + desc + '</p>' : '')
        + '</div></div>';
    }}).join('') : emptyHtml;

    var grid = document.getElementById('galleryGrid');
    if (grid) {{
      grid.innerHTML = cardsHtml;
    }} else {{
      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:24px;max-width:1100px;margin:0 auto;padding:40px 20px';
      wrapper.innerHTML = cardsHtml;
      var main = document.querySelector('main') || document.body;
      main.insertBefore(wrapper, main.firstChild);
    }}
  }}

  fetch(API + '/sites/' + JOB + '/projects')
    .then(function(r) {{ return r.ok ? r.json() : {{projects:[]}}; }})
    .then(function(d) {{ render(d.projects || []); }})
    .catch(function() {{ render([]); }});
}})();
</script>"""


def _contact_cms_script(job_id: str) -> str:
    """Script injected into contact.html to populate contact info from localStorage."""
    contact_key = f"{job_id}-contact"
    return f"""
<script>
(function(){{
  try {{
    var c = JSON.parse(localStorage.getItem('{contact_key}')||'{{}}');
    if (c.phone) {{
      var d = c.phone.replace(/\\D/g,'');
      document.querySelectorAll('a[href^="tel:"]').forEach(function(el){{el.href='tel:'+d;el.textContent=c.phone;}});
    }}
    if (c.email) {{
      document.querySelectorAll('a[href^="mailto:"]').forEach(function(el){{el.href='mailto:'+c.email;el.textContent=c.email;}});
    }}
    if (c.address) {{
      var addrEl = document.getElementById('contact-address-span');
      if (addrEl) addrEl.textContent = c.address;
    }}
  }} catch(_) {{}}
}})();
</script>"""


def _stock_images_cms_script(job_id: str, stock_images: dict, admin_token: str = "") -> str:
    """Script injected into <head> — applies stock images from localStorage overrides AND
    server-uploaded images (GET /sites/{job_id}/images). Server images take precedence."""
    stock_key     = f"{job_id}-stock-images"
    defaults_json = json.dumps(stock_images)
    api_base      = "https://builder.funkfactorymediagroup.com"
    preview       = "https://preview.funkfactorymediagroup.com"
    return f"""
<script>
(function(){{
  var KEY      = '{stock_key}';
  var DEFAULTS = {defaults_json};
  var API      = '{api_base}';
  var JOB      = '{job_id}';
  var TOKEN    = '{admin_token}';
  var PREVIEW  = '{preview}';

  function _swapUrl(oldUrl, newUrl){{
    document.querySelectorAll('img').forEach(function(el){{
      if (el.src === oldUrl || el.getAttribute('src') === oldUrl) el.src = newUrl;
    }});
    document.querySelectorAll('[style]').forEach(function(el){{
      if (el.style.backgroundImage && el.style.backgroundImage.indexOf(oldUrl) >= 0)
        el.style.backgroundImage = el.style.backgroundImage.replace(oldUrl, newUrl);
    }});
  }}

  function _applyLocalStock(){{
    try {{
      var saved = JSON.parse(localStorage.getItem(KEY)||'{{}}');
      Object.keys(saved).forEach(function(slot){{
        var newUrl = saved[slot];
        if (!newUrl || !DEFAULTS[slot] || newUrl === DEFAULTS[slot]) return;
        _swapUrl(DEFAULTS[slot], newUrl);
      }});
    }}catch(_){{}}
  }}

  function _applyServerImages(){{
    if (!TOKEN) return;
    fetch(API+'/sites/'+JOB+'/images', {{headers:{{'X-Admin-Token':TOKEN}}}})
      .then(function(r){{return r.ok?r.json():null;}})
      .then(function(data){{
        if (!data||!data.images) return;
        Object.keys(data.images).forEach(function(slot){{
          var raw = data.images[slot];
          if (!raw) return;
          var abs = raw.startsWith('http') ? raw : PREVIEW+raw;
          abs = abs + (abs.indexOf('?')===-1?'?':'&') + '_v=' + Date.now();
          // Apply by data-stock-slot attribute first, then by URL match
          var el = document.querySelector('[data-stock-slot="'+slot+'"]');
          if (el) {{
            if (el.tagName === 'IMG') el.src = abs;
            else el.style.backgroundImage = 'url('+abs+')';
          }}
          if (DEFAULTS[slot]) _swapUrl(DEFAULTS[slot], abs);
        }});
      }})
      .catch(function(){{}});
  }}

  function _applyAll(){{
    _applyLocalStock();
    _applyServerImages();
  }}

  if (document.readyState === 'loading') {{
    document.addEventListener('DOMContentLoaded', _applyAll);
  }} else {{
    _applyAll();
  }}
}})();
</script>"""


# ── Build phase tracker ───────────────────────────────────────────────────────

def _update_build_phase(job_id: str, job: dict, phase: str, progress: int) -> None:
    job["build_phase"]    = phase
    job["build_progress"] = progress
    _save_job(job_id, job)


# ── File validation ───────────────────────────────────────────────────────────

def validate_file(path: str, content: str) -> bool:
    if not content or len(content.strip()) < 20:
        return False
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    if ext == "html":
        lower = content.lower()
        return "<!doctype" in lower and "<html" in lower
    if ext == "css":
        return "{" in content and "}" in content
    if ext == "js":
        return len(content) >= 50
    if ext == "md":
        return len(content) >= 20
    return len(content) >= 10


# ── Cost estimation ───────────────────────────────────────────────────────────

def estimate_build_cost(plan: dict, existing_files: dict) -> dict:
    files_to_modify = plan.get("files_to_modify", [])
    est_per_file    = plan.get("estimated_tokens_per_file", {})
    total_input = total_output = 0
    for fname in files_to_modify:
        existing_chars = len(existing_files.get(fname, ""))
        input_est      = (existing_chars // 4) + 800
        output_est     = est_per_file.get(fname, max(500, existing_chars // 4))
        total_input   += input_est
        total_output  += output_est
    input_cost  = (total_input  / 1_000_000) * 3.00
    output_cost = (total_output / 1_000_000) * 15.00
    return {
        "estimated_input_tokens":  total_input,
        "estimated_output_tokens": total_output,
        "estimated_cost_usd":      round(input_cost + output_cost, 4),
        "files_estimated":         len(files_to_modify),
    }


# ── Delimiter-aware response parser ──────────────────────────────────────────

def parse_delimiter_response(text: str, filepath: str) -> Optional[str]:
    """Extract file content from Claude's response using multiple fallback strategies.
    Handles token-limit truncation where ===ENDFILE=== may be missing."""
    fname      = filepath.rsplit("/", 1)[-1]
    ext        = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
    end_marker = "===ENDFILE==="

    # Strategy 1: Exact ===FILE: {filepath}=== marker (with or without end marker)
    start_marker = f"===FILE: {filepath}==="
    if start_marker in text:
        start_idx = text.index(start_marker) + len(start_marker)
        if text[start_idx:start_idx + 1] == "\n":
            start_idx += 1
        if end_marker in text[start_idx:]:
            content = text[start_idx:text.index(end_marker, start_idx)]
        else:
            content = text[start_idx:]
            build_log.warning(
                "[build] %s no ENDFILE marker — using truncated content (%d chars) job_id=%s",
                fname, len(content), filepath.split("/")[1] if "/" in filepath else "?",
            )
        content = content.strip()
        if content:
            return content

    # Strategy 2: Any ===FILE: marker (path line stripped), with or without end marker
    if "===FILE:" in text:
        after    = text.split("===FILE:", 1)[1]
        # Skip the path line
        content  = after.split("\n", 1)[1] if "\n" in after else after
        if end_marker in content:
            content = content.split(end_marker, 1)[0]
        else:
            build_log.warning(
                "[build] %s any-FILE marker, no ENDFILE — using truncated content (%d chars)",
                fname, len(content),
            )
        content = content.strip()
        if len(content) > 100:
            return content

    # Strategy 3: HTML — code fence or raw doctype/html tag (supports truncation)
    if ext == "html":
        if "```html" in text:
            raw = text.split("```html", 1)[1]
            return raw.split("```", 1)[0].strip() if "```" in raw else raw.strip()
        tl        = text.lower()
        start_idx = tl.find("<!doctype")
        if start_idx == -1:
            start_idx = tl.find("<html")
        if start_idx != -1:
            end_idx = tl.rfind("</html>")
            # Accept even if </html> is missing (truncation) — take everything from start
            return text[start_idx:end_idx + 7].strip() if end_idx != -1 else text[start_idx:].strip()

    # Strategy 4: CSS — code fence or bare block
    if ext == "css":
        if "```css" in text:
            raw = text.split("```css", 1)[1]
            return raw.split("```", 1)[0].strip() if "```" in raw else raw.strip()
        if "{" in text and len(text.strip()) > 50:
            start = next((text.find(c) for c in ("*", "body", ":root", "@") if text.find(c) != -1), 0)
            return text[start:].strip()

    # Strategy 5: JS — code fence or bare script
    if ext == "js":
        for fence in ("```javascript", "```js"):
            if fence in text:
                raw = text.split(fence, 1)[1]
                return raw.split("```", 1)[0].strip() if "```" in raw else raw.strip()
        if any(kw in text for kw in ("function", "const ", "document.", "window.")):
            return text.strip()

    # Strategy 6: Markdown — code fence or bare text
    if ext == "md":
        for fence in ("```markdown", "```md"):
            if fence in text:
                raw = text.split(fence, 1)[1]
                return raw.split("```", 1)[0].strip() if "```" in raw else raw.strip()
        if len(text.strip()) > 20:
            return text.strip()

    return None


# ── Per-file analysis and execution ──────────────────────────────────────────

async def analyze_changes(
    job_id: str,
    business_name: str,
    pending_changes: list,
    existing_filenames: list,
    claude_client,
) -> dict:
    """Quick Claude call (max 1000 tokens) to identify which files need changes."""
    change_lines = "\n".join(f"- {cr['notes']}" for cr in pending_changes)
    files_list   = ", ".join(existing_filenames)
    prompt = (
        f"Website update plan for {business_name}.\n\n"
        f"CHANGE REQUESTS:\n{change_lines}\n\n"
        f"EXISTING FILES: {files_list}\n\n"
        f"Return ONLY this JSON:\n"
        f'{{"files_to_modify": ["filename"], '
        f'"files_to_create": [], '
        f'"changes_per_file": {{"filename": "what to change"}}, '
        f'"estimated_tokens_per_file": {{"filename": 1500}}, '
        f'"skip_files": ["filename"]}}'
    )
    try:
        response = await claude_client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1000,
            messages=[{"role": "user", "content": prompt}],
        )
        raw  = response.content[0].text
        plan = _strip_think_and_parse(raw)
        build_log.info("[build] analyze_changes plan job_id=%s modify=%s",
                       job_id, plan.get("files_to_modify"))
        return plan
    except Exception as exc:
        build_log.warning("[build] analyze_changes failed job_id=%s: %r — modifying all files", job_id, exc)
        return {
            "files_to_modify": existing_filenames,
            "files_to_create": [],
            "changes_per_file": {f: "apply all change requests" for f in existing_filenames},
            "estimated_tokens_per_file": {f: 2000 for f in existing_filenames},
            "skip_files": [],
        }


async def execute_file(
    job_id: str,
    filepath: str,
    existing_content: str,
    change_desc: str,
    is_new: bool,
    retry: int,
    claude_client,
    system_prompt: str,   # kept for API compat; overridden internally
    brief_context: str,
) -> tuple:
    """Generate or modify one file. Returns (content, input_tokens, output_tokens) or (None, 0, 0)."""
    fname          = filepath.rsplit("/", 1)[-1]
    existing_chars = len(existing_content)
    existing_tokens = existing_chars // 4
    max_tokens      = min(existing_tokens + 4000, 16000)

    # FIX 2: path-specific system prompt — impossible to miss
    _system = (
        f"You are a website file generator.\n"
        f"You MUST follow this output format with NO exceptions:\n\n"
        f"===FILE: {filepath}===\n"
        f"[file content here]\n"
        f"===ENDFILE===\n\n"
        f"RULES:\n"
        f"- Start your response with ===FILE: {filepath}=== immediately\n"
        f"- No preamble, no explanation, no markdown fences\n"
        f"- No ```html or ``` code fences\n"
        f"- Nothing before ===FILE: and nothing after ===ENDFILE===\n"
        f"- Return the COMPLETE file content between the delimiters"
    )

    retry_note = (
        f"\n\nCRITICAL: Your previous response did NOT use the required format. "
        f"You MUST start with ===FILE: {filepath}=== on the very first line."
        if retry > 0 else ""
    )

    format_reminder = (
        f"Return the file using EXACTLY this format, starting with ===FILE: on the very first line:\n\n"
        f"===FILE: {filepath}===\n"
        f"[{'generate complete' if is_new else 'complete updated'} {fname} content here]\n"
        f"===ENDFILE===\n\n"
    )

    if is_new:
        prompt = (
            f"{format_reminder}"
            f"Generate the complete {fname} file.\n"
            f"Changes: {change_desc}\n\n"
            f"{brief_context}{retry_note}"
        )
    else:
        prompt = (
            f"{format_reminder}"
            f"Modify {fname} — apply ONLY these changes:\n{change_desc}\n\n"
            f"RULES: Preserve existing design, colors, fonts, sections. Return COMPLETE file.\n\n"
            f"EXISTING FILE:\n{_scrub_b64(existing_content)}\n\n"
            f"{brief_context}{retry_note}"
        )

    try:
        raw_text = ""
        async with claude_client.messages.stream(
            model="claude-sonnet-4-20250514",
            max_tokens=max_tokens,
            system=_system,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            async for text in stream.text_stream:
                raw_text += text
        usage           = (await stream.get_final_message()).usage
        in_tok, out_tok = usage.input_tokens, usage.output_tokens
        build_log.info("[build] execute_file %s attempt=%d tokens_in=%d tokens_out=%d job_id=%s",
                       fname, retry, in_tok, out_tok, job_id)

        # FIX 3: multi-strategy extraction; FIX 1: debug log on failure
        content = parse_delimiter_response(raw_text, filepath)
        if content:
            if validate_file(filepath, content):
                return content, in_tok, out_tok
            build_log.warning("[build] execute_file %s attempt=%d validation failed job_id=%s",
                              fname, retry, job_id)
        else:
            build_log.warning(
                "[build] execute_file %s attempt=%d no delimited block — raw preview: %r job_id=%s",
                fname, retry, raw_text[:200], job_id,
            )
    except Exception as exc:
        build_log.error("[build] execute_file %s attempt=%d error=%r job_id=%s", fname, retry, exc, job_id)
    return None, 0, 0


# ── Build background task ─────────────────────────────────────────────────────

async def build_website(job_id: str, force_claude: bool, build_mode: str = "messages_api", rebuild_mode: str = "update") -> None:
    build_log.info("[build] Starting job_id=%s force_claude=%s", job_id, force_claude)

    # Step 1 — Load job
    job = _load_job(job_id)
    if job is None:
        build_fail_log.error("BUILD_FAILED job_id=%s reason=job_file_not_found", job_id)
        return

    _update_build_phase(job_id, job, "starting", 5)

    brief         = job.get("original_brief", {})
    contact       = brief.get("contact", {})
    project       = brief.get("project", {})
    brand         = brief.get("brand") or {}
    delivery      = brief.get("delivery") or {}
    customer_uuid = job.get("customer_uuid", "")
    business_name = contact.get("business_name", "Unknown Business")
    industry      = contact.get("industry", "")
    goal          = project.get("goal", "")
    tone_raw      = project.get("tone", [])
    tone          = ", ".join(tone_raw) if isinstance(tone_raw, list) else str(tone_raw)
    audience      = project.get("target_audience", "")
    pages_raw     = project.get("pages", [])
    colors        = brand.get("colors") or []
    package_name  = brief.get("package") or "standard"

    cw_map = {"Yes": "needs_writing", "No, I'll provide it": "provided", "Mix of both": "mixed"}
    copy_status = cw_map.get(brand.get("content_writing_needed", ""), "mixed")

    # Extract extended brief fields
    hero_text   = project.get("hero_text") or project.get("tagline") or ""
    tagline     = project.get("tagline") or project.get("slogan") or ""
    services    = project.get("services") or brief.get("services") or []
    reviews     = project.get("reviews") or brief.get("reviews") or []
    phone       = contact.get("phone") or contact.get("phone_number") or ""
    email       = contact.get("email") or ""
    address     = contact.get("address") or contact.get("location") or ""
    extra_copy  = project.get("copy") or project.get("additional_copy") or project.get("content") or ""

    # Step 2 — Package spec
    spec       = _pkg(package_name)
    pages      = pages_raw[:spec["max_pages"]]
    is_premium = spec["premium"]

    # ── REPUBLISH MODE — zero-cost copy of existing files ────────────────────
    if rebuild_mode == "republish":
        _output_dir = WEBSITE_BUILDS_DIR / "customers" / job_id
        if not (_output_dir / "index.html").exists():
            _fail_retryable(job_id, job, "republish_no_files", "no existing build files found to republish")
            return
        _update_build_phase(job_id, job, "republishing", 50)
        preview_expires_at = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
        try:
            caddy_site = Path(f"/srv/sites/{job_id}")
            if caddy_site.exists():
                shutil.rmtree(str(caddy_site))
            shutil.copytree(str(_output_dir), str(caddy_site))
            preview_url = f"https://{PREVIEW_DOMAIN}/{job_id}"
            build_log.info("[build] Republish caddy copy done job_id=%s url=%s", job_id, preview_url)
        except Exception as exc:
            _fail_retryable(job_id, job, "republish_caddy", str(exc))
            return
        built_at = _now()
        job.update({
            "build_status":       "completed",
            "built_at":           built_at,
            "preview_url":        preview_url,
            "preview_expires_at": preview_expires_at,
            "build_phase":        "complete",
            "build_progress":     100,
        })
        _save_job(job_id, job)
        _update_index_entry(job_id, {"status": "preview_ready"})
        build_success_log.info("BUILD_SUCCESS job_id=%s mode=republish preview=%s", job_id, preview_url)
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.post(
                    POLSIA_PREVIEW_URL,
                    headers={"Content-Type": "application/json", "X-Polsia-Secret": POLSIA_SECRET},
                    json={
                        "job_id":             job_id,
                        "customer_uuid":      customer_uuid,
                        "status":             "preview_ready",
                        "preview_url":        preview_url,
                        "preview_expires_at": preview_expires_at,
                        "package":            package_name,
                        "pages_built":        [],
                        "built_at":           built_at,
                        "notes":              "Republished from existing build",
                    },
                )
                r.raise_for_status()
                job["preview_notified"] = True
                _save_job(job_id, job)
        except Exception as exc:
            build_fail_log.warning("POLSIA_NOTIFY_FAILED job_id=%s error=%s", job_id, str(exc)[:200])
        return

    # Step 3 — Call Claude
    if not ANTHROPIC_API_KEY:
        _fail_retryable(job_id, job, "no_api_key", "ANTHROPIC_API_KEY not configured")
        return

    # Reload job fresh to catch change_requests added after this build was queued
    fresh_job = _load_job(job_id)
    if fresh_job:
        job["change_requests"] = fresh_job.get("change_requests") or []

    pending_changes = [cr for cr in (job.get("change_requests") or []) if not cr.get("applied")]
    build_log.info("[build] job_id=%s pending_changes=%d", job_id, len(pending_changes))

    # Prompt-safe copies — base64 data is handled only in post-processing, never in prompt text
    brief_safe   = _scrub_obj(brief)
    changes_safe = _scrub_obj(pending_changes)

    # Collect images as data URIs — injected into HTML post-generation, NOT sent to Claude.
    # This avoids massive request payloads and ReadTimeouts.
    _LOGO_PH    = "FFMG_LOGO_DATA_URI"
    _GALLERY_PH = "FFMG_GALLERY_{n}_DATA_URI"

    logo_data_uri    = ""
    gallery_data_uris: list = []  # list of (placeholder, data_uri)

    # ── Logo: resolve from brief or change request images (persists to brief) ──
    _logo_b64 = resolve_logo(job)
    if _logo_b64:
        brand = (job.get("original_brief") or {}).get("brand") or {}
        _ct   = brand.get("logo_content_type") or "image/png"
        logo_data_uri = f"data:{_ct};base64,{_logo_b64}"
        _save_job(job_id, job)  # persist any logo/colors written by resolve_logo
        build_log.info("[build] job_id=%s logo resolved from %s",
                       job_id, "brief" if not brand.get("logo_data_uri") else "change_request")
    else:
        for img in (brief.get("images") or []):
            if img.get("base64"):
                logo_data_uri = f"data:{img.get('content_type', 'image/png')};base64,{img['base64']}"
                break

    # ── Gallery: change request images that are NOT the logo ──────────────────
    for cr in pending_changes:
        for img in (cr.get("images") or []):
            if not img.get("base64"):
                continue
            fname_lower = (img.get("filename") or "").lower()
            if any(x in fname_lower for x in ["logo", "brand", "icon"]):
                continue  # already handled by resolve_logo
            n = len(gallery_data_uris) + 1
            placeholder = _GALLERY_PH.format(n=n)
            gallery_data_uris.append((placeholder, f"data:{img.get('content_type', 'image/jpeg')};base64,{img['base64']}"))

    total_image_count = (1 if logo_data_uri else 0) + len(gallery_data_uris)
    build_log.info("[build] job_id=%s logo=%s gallery=%d", job_id, bool(logo_data_uri), len(gallery_data_uris))

    # ── Color extraction and theme detection ──────────────────────────────────
    extracted_logo_colors = extract_dominant_colors(logo_data_uri)
    _logo_dominant        = (brand.get("logo_dominant_colors") or []) or extracted_logo_colors
    site_theme            = detect_theme(brief, _logo_dominant or extracted_logo_colors)
    colors_source         = "brief" if colors else ("extracted" if extracted_logo_colors else "none")
    if extracted_logo_colors:
        build_log.info("[build] job_id=%s extracted_colors=%s", job_id, extracted_logo_colors)
    build_log.info("[build] job_id=%s site_theme=%s colors_source=%s", job_id, site_theme, colors_source)

    # ── Stock images ──────────────────────────────────────────────────────────
    stock_images = get_stock_images(industry)
    build_log.info("[build] Stock images: industry=%s urls=%d job_id=%s", industry, len(stock_images), job_id)

    image_block = (
        f"STOCK IMAGES — USE THESE REAL UNSPLASH URLS:\n"
        f"These are live royalty-free photo URLs. Use them directly as src or CSS background-image values.\n"
        f"Do NOT use placeholder.com or picsum.photos.\n"
        f"Always add loading=\"lazy\" and descriptive alt text.\n\n"
        f"Hero background (add dark overlay for text readability):\n"
        f"  {stock_images['hero']}\n\n"
        f"Gallery / Portfolio images:\n"
        f"  {stock_images['gallery_1']}\n"
        f"  {stock_images['gallery_2']}\n"
        f"  {stock_images['gallery_3']}\n"
        f"  {stock_images['gallery_4']}\n"
        f"  {stock_images['gallery_5']}\n"
        f"  {stock_images['gallery_6']}\n\n"
        f"Service card images:\n"
        f"  {stock_images['service_1']}\n"
        f"  {stock_images['service_2']}\n"
        f"  {stock_images['service_3']}\n\n"
        f"About / CTA section:\n"
        f"  {stock_images['about']}\n"
        f"  {stock_images['cta']}\n\n"
        f"Hero usage example:\n"
        f"  <section style=\"background-image: url('{stock_images['hero']}'); background-size: cover; background-position: center;\">\n"
        f"    <div style=\"background: rgba(0,0,0,0.65); padding: 120px 0;\">[hero content]</div>\n"
        f"  </section>\n"
    )

    # ── Gallery admin detection ───────────────────────────────────────────────
    _all_change_requests = job.get("change_requests") or []
    needs_gallery_admin  = _needs_gallery_admin(brief, _all_change_requests)
    admin_password       = _extract_admin_password(_all_change_requests)
    if needs_gallery_admin:
        build_log.info("[build] Gallery admin requested — will generate admin/index.html job_id=%s", job_id)

    colors_str      = ", ".join(colors) if colors else "generate a warm professional palette"
    premium_section = (
        "- Add schema.org JSON-LD markup to every page\n"
        "- Generate a sitemap.xml\n"
        "- Add Open Graph meta tags to every page\n"
        "- Add meta descriptions to every page"
        if is_premium else
        "- Add basic meta title and description to every page"
    )

    # Build optional brief sections
    services_block = ""
    if services:
        if isinstance(services, list):
            svc_names = []
            for s in services:
                if isinstance(s, dict):
                    svc_names.append(s.get("name") or s.get("title") or s.get("service") or "[service]")
                else:
                    svc_names.append(_scrub_b64(str(s)))
            services_block = f"Services: {', '.join(svc_names)}\n"
        else:
            services_block = f"Services: {_scrub_b64(str(services))}\n"

    reviews_block = ""
    if reviews:
        if isinstance(reviews, list):
            reviews_block = "Reviews/Testimonials (use these VERBATIM):\n" + "\n".join(
                f"  - \"{r.get('text') or r.get('review') or r.get('body') or '[review]'}\" — {r.get('author') or r.get('name') or ''}"
                if isinstance(r, dict) else f"  - \"{_scrub_b64(str(r))}\""
                for r in reviews
            ) + "\n"
        else:
            reviews_block = f"Reviews: {_scrub_b64(str(reviews))}\n"

    contact_block = ""
    if phone or email or address:
        contact_block = (
            f"Contact details (use these EXACTLY — do NOT invent placeholder phone/email):\n"
            + (f"  Phone: {phone}\n" if phone else "")
            + (f"  Email: {email}\n" if email else "")
            + (f"  Address: {address}\n" if address else "")
        )

    extra_copy   = _scrub_b64(extra_copy) if extra_copy else ""
    hero_block   = f"Hero text / tagline: {hero_text}\n" if hero_text else ""
    extra_block  = f"Additional copy provided by client (use verbatim):\n{extra_copy}\n" if extra_copy else ""

    logo_block = ""
    if logo_data_uri:
        logo_block = (
            f"LOGO: A logo image has been provided. Use the placeholder value {_LOGO_PH} as the src "
            f"for the logo <img> tag — it will be replaced with the real data URI automatically after build.\n"
            f"Example: <img src=\"{_LOGO_PH}\" alt=\"{business_name} Logo\" class=\"logo\" style=\"height:60px\">\n"
            f"Place the logo in the site header/navbar on every page.\n"
        )

    gallery_block = ""
    if gallery_data_uris:
        lines = [f"  Gallery image {i+1}: use src=\"{ph}\" — will be replaced automatically"
                 for i, (ph, _) in enumerate(gallery_data_uris)]
        gallery_block = "GALLERY IMAGES (placeholders — replaced after build):\n" + "\n".join(lines) + "\n"

    change_block = ""
    if pending_changes:
        change_lines = "\n".join(f"  {i+1}. {cr['notes']}" for i, cr in enumerate(pending_changes))
        cr_img_names = [
            img["filename"]
            for cr in pending_changes
            for img in (cr.get("images") or [])
            if img.get("filename")
        ]
        img_note = f"\n  Images uploaded (embedded via placeholder above): {', '.join(cr_img_names)}" if cr_img_names else ""
        change_block = (
            f"\n⚠️  CHANGE REQUESTS — MUST BE APPLIED:\n"
            f"{change_lines}{img_note}\n"
            f"Apply every change request above.\n"
        )

    # ── Shared brief block — passed to every per-file call ───────────────────
    brief_block = (
        f"CLIENT BRIEF:\n"
        f"Business: {business_name}\n"
        f"Industry: {industry}\n"
        f"Goal: {goal}\n"
        f"Pages: {', '.join(pages)}\n"
        f"Tone: {tone}\n"
        f"Audience: {audience}\n"
        f"Brand colors: {colors_str}\n"
        f"Package: {package_name}\n"
        f"Copy needed: {copy_status}\n"
        f"{hero_block}"
        f"{services_block}"
        f"{contact_block}"
        f"{reviews_block}"
        f"{extra_block}"
        f"{logo_block}"
        f"{gallery_block}"
    )

    # ── Color block ───────────────────────────────────────────────────────────
    _all_colors    = colors + [c for c in _logo_dominant if c not in colors]
    _primary_color = _all_colors[0] if _all_colors else "#333333"

    if _all_colors:
        _color_lines = "\n".join(f"  - {c}" for c in _all_colors)
        _logo_colors_note = (
            f"\nLogo dominant colors (use for accents/harmony): {', '.join(_logo_dominant)}"
            if _logo_dominant else ""
        )
        color_block = (
            f"CRITICAL BRAND COLORS — USE ONLY THESE:\n"
            f"{_color_lines}"
            f"{_logo_colors_note}\n\n"
            f"These are the CLIENT'S brand colors. Apply them throughout the entire site.\n"
            f"Do NOT use any other colors as primary/accent colors.\n"
            f"Do NOT use brown (#6B3A1F), copper (#D4956A), or tan as primary colors — those are FFMG internal colors.\n"
        )
    else:
        color_block = (
            "No brand colors specified. Use a professional dark theme with subtle accent colors "
            "appropriate for the industry.\n"
            "Do NOT use brown or copper — those are reserved for FFMG internal use.\n"
        )

    # ── Theme block ───────────────────────────────────────────────────────────
    if site_theme == "light":
        theme_block = (
            "SITE THEME: LIGHT — use a light/white background with dark text. "
            "Reserve brand colors for accents, buttons, and highlights.\n"
        )
    else:
        theme_block = (
            "SITE THEME: DARK — use a near-black background (#0a0a0a or similar) with light text. "
            "Reserve brand colors for accents, highlights, and calls-to-action.\n"
        )

    path_reqs = (
        f"ROOT-RELATIVE ASSET PATHS — all paths must use /{job_id}/ prefix:\n"
        f"  Correct: <link rel=\"stylesheet\" href=\"/{job_id}/css/style.css\">\n"
        f"  Correct: <script src=\"/{job_id}/js/main.js\"></script>\n"
        f"  Correct: <a href=\"/{job_id}/services.html\">Services</a>\n"
        f"  Wrong:   href=\"css/style.css\" or href=\"./css/style.css\"\n"
    )

    system_prompt = (
        "You are an expert web developer. You receive a client brief and generate ONE specific file. "
        "Return ONLY valid JSON with exactly two keys: \"path\" and \"content\". "
        "No markdown fences, no preamble, no explanation — only the JSON object. "
        "CRITICAL: All asset paths and internal links must use root-relative paths with the job_id prefix.\n\n"
        "CRITICAL RULES:\n"
        "- Use the EXACT hero text, brand colors, reviews, contact details, and service names from the brief\n"
        "- Do NOT invent placeholder phone numbers, emails, or addresses\n"
        "- Write realistic, specific copy — no Lorem ipsum\n"
        "- If a logo placeholder is specified, use it as the img src exactly as shown\n"
        "- Match the aesthetic described in the brief exactly\n"
        "- If a dark/dramatic aesthetic is specified, background must be near-black with the specified accent color"
    )

    # ── Fixed file list — always generate these 8 files ──────────────────────
    _SITE_FILES = [
        {"name": "index.html",    "description": "Homepage with hero, services preview, testimonials, CTA"},
        {"name": "services.html", "description": "Full services page with all service offerings and descriptions"},
        {"name": "gallery.html",  "description": "Project gallery with before/after photos grid"},
        {"name": "reviews.html",  "description": "Customer reviews and testimonials page"},
        {"name": "contact.html",  "description": "Contact form, phone, email, service area, map"},
        {"name": "css/style.css", "description": "Complete stylesheet for all pages — dark theme, brand colors"},
        {"name": "js/main.js",    "description": "Navigation, mobile menu, gallery lightbox, form handling"},
        {"name": "README.md",     "description": "Project documentation and deployment instructions"},
    ]

    files_to_generate = [f"customers/{job_id}/{f['name']}" for f in _SITE_FILES]

    _NAV_LINKS = (
        f'<a href="/{job_id}/index.html">Home</a>\n'
        f'<a href="/{job_id}/services.html">Services</a>\n'
        f'<a href="/{job_id}/gallery.html">Gallery</a>\n'
        f'<a href="/{job_id}/reviews.html">Reviews</a>\n'
        f'<a href="/{job_id}/contact.html">Contact</a>'
    )

    _file_desc = {f["name"]: f["description"] for f in _SITE_FILES}

    def _per_file_prompt(file_path: str) -> str:
        fname = file_path.rsplit("/", 1)[-1]
        desc  = _file_desc.get(fname, fname)

        if fname == "index.html":
            instruction = (
                f"Generate ONLY the index.html homepage for {business_name}'s website.\n"
                f"Description: {desc}\n"
                f"Google Analytics gtag placeholder with TODO comment.\n"
                f"Navigation must use these exact links:\n{_NAV_LINKS}\n"
                f"{premium_section}\n"
                f"FEATURED PROJECTS SECTION: Include a featured projects grid section with id='featured-projects-grid'.\n"
                f"Give each project card element the class 'project-card' and use a dark background (#1a1a1a) "
                f"for card image slots — do NOT hard-code any Unsplash/stock image URLs in the project cards.\n"
                f"At the bottom of </body>, add this script to populate the grid from the live server:\n"
                f"<script>\n"
                f"(function(){{\n"
                f"  var PREVIEW='https://preview.funkfactorymediagroup.com';\n"
                f"  function absUrl(u){{return u&&u.startsWith('http')?u:PREVIEW+u;}}\n"
                f"  function cover(p){{\n"
                f"    var m=p.media||[];var i=p.cover_index||0;\n"
                f"    if(m[i]&&m[i].type==='image')return absUrl(m[i].data||m[i].url||'');\n"
                f"    for(var j=0;j<m.length;j++)if(m[j].type==='image')return absUrl(m[j].data||m[j].url||'');\n"
                f"    var ph=(p.photos||[]).filter(function(s){{return s&&!s.startsWith('data:video');}});\n"
                f"    return absUrl(ph[0]||'');\n"
                f"  }}\n"
                f"  fetch('https://builder.funkfactorymediagroup.com/sites/{job_id}/projects')\n"
                f"    .then(function(r){{return r.ok?r.json():{{projects:[]}}}})\n"
                f"    .then(function(d){{\n"
                f"      var ps=(d.projects||[]).filter(function(p){{return p.visible!==false;}}).slice(0,6);\n"
                f"      var grid=document.getElementById('featured-projects-grid');if(!grid)return;\n"
                f"      if(!ps.length){{grid.style.display='none';return;}}\n"
                f"      var cards=grid.querySelectorAll('.project-card');\n"
                f"      ps.forEach(function(p,i){{\n"
                f"        var c=cards[i];if(!c)return;\n"
                f"        var img=cover(p);\n"
                f"        var bg=c.querySelector('[data-cover]')||c.querySelector('.project-img');\n"
                f"        if(bg&&img){{bg.style.backgroundImage='url('+img+')';bg.style.backgroundSize='cover';}}\n"
                f"        var nm=c.querySelector('[data-name]')||c.querySelector('.project-name');\n"
                f"        if(nm)nm.textContent=p.name||p.title||'';\n"
                f"        var ct=c.querySelector('[data-cat]')||c.querySelector('.project-cat');\n"
                f"        if(ct)ct.textContent=p.category||'';\n"
                f"        c.style.display='';\n"
                f"      }});\n"
                f"      for(var i=ps.length;i<cards.length;i++)cards[i].style.display='none';\n"
                f"    }}).catch(function(){{}});\n"
                f"}})();\n"
                f"</script>\n"
                f"IMPORTANT: Each .project-card must have child elements with data-cover, data-name, and data-cat attributes."
            )
        elif fname == "style.css":
            instruction = (
                f"Generate ONLY the css/style.css stylesheet for {business_name}'s website.\n"
                f"Description: {desc}\n"
                f"Shared by all pages — layout, typography, components, responsive breakpoints.\n"
                f"Mobile-first. No external fonts or icon libraries."
            )
        elif fname == "main.js":
            instruction = (
                f"Generate ONLY the js/main.js file for {business_name}'s website.\n"
                f"Description: {desc}\n"
                f"Vanilla JS only — no libraries."
            )
        elif fname == "README.md":
            instruction = (
                f"Generate ONLY the README.md for this project.\n"
                f"Include:\n"
                f"- Project: {business_name} Website\n"
                f"- Built by: Funk Factory Media Group\n"
                f"- Job ID: {job_id}\n"
                f"- Package: {spec['label']}\n"
                f"- Pages: Home, Services, Gallery, Reviews, Contact\n"
                f"- Stack: Static HTML/CSS/JS\n"
                f"- Post-launch support: {spec['support']} days\n"
                f"- Deploy: cPanel file manager upload instructions"
            )
        else:
            instruction = (
                f"Generate ONLY the {fname} for {business_name}'s website.\n"
                f"Description: {desc}\n"
                f"Navigation must use these exact links:\n{_NAV_LINKS}\n"
                f"{premium_section}"
            )
        return (
            f"{color_block}\n"
            f"{theme_block}\n"
            f"{image_block}\n"
            f"{instruction}\n\n"
            f"{brief_block}\n"
            f"{path_reqs}\n"
            f"Return ONLY a valid JSON object — no markdown, no preamble, no trailing text:\n"
            f'{{"path": "{file_path}", "content": "complete file content here"}}\n\n'
            f"The content value must be a properly encoded JSON string.\n"
            f"Escape double quotes as \\\" and backslashes as \\\\.\n"
            f"Single quotes do not need escaping."
        )

    _claude = _anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY, timeout=300.0)

    input_tokens = output_tokens = 0
    files:       list = []
    pages_built: list = []
    files_actually_modified: set = set()  # filenames where Claude succeeded (not fallback)
    summary = f"Generated {business_name} website — {len(files_to_generate)} files"

    # ── Mode detection ────────────────────────────────────────────────────────
    _output_dir   = WEBSITE_BUILDS_DIR / "customers" / job_id
    _has_existing = (_output_dir / "index.html").exists()
    use_update    = (rebuild_mode != "full") and _has_existing
    build_log.info("[build] Mode: %s job_id=%s rebuild_mode=%s has_existing=%s",
                   "UPDATE" if use_update else "FULL REBUILD", job_id, rebuild_mode, _has_existing)

    # ── UPDATE MODE — read existing files, apply only the requested changes ──
    if use_update:
        _update_filenames = [
            "index.html", "services.html", "gallery.html",
            "reviews.html", "contact.html", "css/style.css", "js/main.js",
        ]
        existing_contents = {
            fn: (_output_dir / fn).read_text(encoding="utf-8")
            for fn in _update_filenames
            if (_output_dir / fn).exists()
        }

        if not existing_contents:
            build_log.warning("[build] UPDATE mode but no readable files — falling back to FULL REBUILD job_id=%s", job_id)
            use_update = False

        elif not pending_changes:
            build_log.info("[build] UPDATE mode — no pending changes, republishing existing files job_id=%s", job_id)
            files = [
                {"path": f"customers/{job_id}/{fn}", "content": content}
                for fn, content in existing_contents.items()
            ]

        else:
            # ── ANALYZE: quick call to identify which files need changes ──────
            _update_build_phase(job_id, job, "analyzing", 15)
            analysis_filenames = list(existing_contents.keys())
            plan = await analyze_changes(
                job_id, business_name, pending_changes, analysis_filenames, _claude
            )
            files_to_modify  = plan.get("files_to_modify", analysis_filenames)
            files_to_create  = plan.get("files_to_create", [])
            changes_per_file = plan.get("changes_per_file", {})

            # ── ESTIMATE: log pre-build cost before spending tokens ───────────
            cost_est = estimate_build_cost(plan, existing_contents)
            build_log.info(
                "[build] Cost estimate job_id=%s files=%d est_in=%d est_out=%d est_cost=$%.4f",
                job_id, cost_est["files_estimated"],
                cost_est["estimated_input_tokens"], cost_est["estimated_output_tokens"],
                cost_est["estimated_cost_usd"],
            )

            # ── EXECUTE: per-file with validation and up to 2 retries ─────────
            logo_note = (
                f"\nA new logo has been provided. "
                f"Insert <img src=\"{_LOGO_PH}\" alt=\"{business_name} Logo\" "
                f"class=\"logo\" style=\"height:60px\"> in the site header on every page.\n"
                if logo_data_uri else ""
            )
            update_system = (
                "You are an expert web developer applying targeted changes to a live website. "
                "Preserve all existing design, functionality, and content exactly unless explicitly asked to change it. "
                "Use the ===FILE: path===...===ENDFILE=== delimiter format."
            )
            brief_ctx = f"{color_block}\n{theme_block}\n{image_block}\n{logo_note}\nCLIENT: {business_name}"

            total_to_modify = len(files_to_modify) + len(files_to_create)
            _update_build_phase(job_id, job, "generating", 20)

            for file_idx, fname in enumerate(files_to_modify):
                filepath    = f"customers/{job_id}/{fname}"
                existing_c  = existing_contents.get(fname, "")
                change_desc = changes_per_file.get(
                    fname, "\n".join(f"- {cr['notes']}" for cr in pending_changes)
                )
                progress = 20 + int(70 * file_idx / max(total_to_modify, 1))
                _update_build_phase(job_id, job, f"generating_{file_idx+1}_of_{total_to_modify}", progress)

                new_content = None
                _succeeded  = False
                for retry in range(3):
                    content, in_tok, out_tok = await execute_file(
                        job_id, filepath, existing_c, change_desc, False, retry,
                        _claude, update_system, brief_ctx,
                    )
                    input_tokens  += in_tok
                    output_tokens += out_tok
                    if content is not None:
                        new_content = content
                        _succeeded  = True
                        break
                if not _succeeded and existing_c:
                    build_log.warning(
                        "[build] execute_file %s all retries failed — keeping original job_id=%s",
                        fname, job_id,
                    )
                    new_content = existing_c
                if new_content is not None:
                    existing_contents[fname] = new_content
                if _succeeded:
                    files_actually_modified.add(fname)

            for fname in files_to_create:
                filepath    = f"customers/{job_id}/{fname}"
                change_desc = changes_per_file.get(fname, "create this new file")
                file_idx    = len(files_to_modify) + files_to_create.index(fname)
                progress    = 20 + int(70 * file_idx / max(total_to_modify, 1))
                _update_build_phase(job_id, job, f"generating_{file_idx+1}_of_{total_to_modify}", progress)

                for retry in range(3):
                    content, in_tok, out_tok = await execute_file(
                        job_id, filepath, "", change_desc, True, retry,
                        _claude, update_system, brief_ctx,
                    )
                    input_tokens  += in_tok
                    output_tokens += out_tok
                    if content is not None:
                        existing_contents[fname] = content
                        files_actually_modified.add(fname)
                        break

            # Rebuild files list from updated existing_contents
            files = [
                {"path": f"customers/{job_id}/{fn}", "content": fc}
                for fn, fc in existing_contents.items()
            ]

    # ── FULL REBUILD — generate all 8 files from scratch ─────────────────────
    if not use_update:
        # ── Step 3a: Per-file generation ──────────────────────────────────────
        _update_build_phase(job_id, job, "generating", 20)
        build_log.info("[build] Generating %d files job_id=%s", len(files_to_generate), job_id)
        for _fi, file_path in enumerate(files_to_generate):
            fname  = file_path.rsplit("/", 1)[-1]
            _update_build_phase(
                job_id, job,
                f"generating_{_fi+1}_of_{len(files_to_generate)}",
                20 + int(65 * _fi / max(len(files_to_generate), 1)),
            )
            prompt = _per_file_prompt(file_path)
            build_log.info("[build] Generating %s job_id=%s prompt_size=%d chars mode=%s", fname, job_id, len(prompt), build_mode)
            try:
                raw_text = ""
                _cli_path = shutil.which("claude")
                if build_mode == "claude_cli" and _cli_path:
                    full_prompt = f"{system_prompt}\n\n{prompt}"
                    proc = await asyncio.create_subprocess_exec(
                        _cli_path, "-p", full_prompt, "--output-format", "text",
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=300)
                    raw_text = stdout.decode("utf-8", errors="replace")
                    f_in = f_out = 0
                    build_log.info("[build] %s complete via claude CLI job_id=%s", fname, job_id)
                else:
                    async with _claude.messages.stream(
                        model="claude-sonnet-4-20250514",
                        max_tokens=8000,
                        system=system_prompt,
                        messages=[{"role": "user", "content": prompt}],
                    ) as stream:
                        async for text in stream.text_stream:
                            raw_text += text
                    usage = (await stream.get_final_message()).usage
                    f_in  = usage.input_tokens
                    f_out = usage.output_tokens
                input_tokens  += f_in
                output_tokens += f_out
                build_log.info("[build] %s complete: %d output tokens job_id=%s", fname, f_out, job_id)
                result  = _strip_think_and_parse(raw_text)
                content = result.get("content", "")
                content = content.replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "")
                if content and validate_file(file_path, content):
                    files.append({"path": file_path, "content": content})
                    if fname.endswith(".html"):
                        pages_built.append(fname)
                else:
                    build_log.warning("[build] %s: empty or invalid content — skipping job_id=%s", fname, job_id)
            except Exception as exc:
                build_log.error("[build] %s failed job_id=%s type=%s error=%r — continuing",
                                fname, job_id, type(exc).__name__, exc)

        if not files:
            _fail_retryable(job_id, job, "all_file_calls_failed", "no files were generated")
            return

        build_log.info("[build] Per-file generation done: %d/%d files, %d total output tokens job_id=%s",
                       len(files), len(files_to_generate), output_tokens, job_id)

        # ── Step 3b: Call 2 — apply change requests (only if pending) ─────────
        if pending_changes:
            change_lines = "\n".join(f"  {i+1}. {cr['notes']}" for i, cr in enumerate(pending_changes))
            logo_note = (
                f"\nLOGO: Place the logo img tag using src=\"{_LOGO_PH}\" in the header of every page.\n"
                if logo_data_uri else ""
            )
            html_context = "\n\n".join(
                f"=== {e['path']} ===\n{_scrub_b64(e['content'])}"
                for e in files if e.get("path", "").endswith(".html")
            )
            call2_prompt = (
                f"A website has been generated for {business_name}. "
                f"Apply the following change requests by modifying the HTML as needed. "
                f"Do NOT regenerate from scratch — only change what is required.\n\n"
                f"CHANGE REQUESTS:\n{change_lines}\n"
                f"{logo_note}\n"
                f"CURRENT HTML FILES:\n{html_context}\n\n"
                f"Return ONLY the modified files in this exact JSON format:\n"
                f'{{"files": [{{"path": "customers/{job_id}/filename.html", "content": "full modified html"}}]}}\n'
                f"Include ONLY files that were actually changed. Return complete file content, not diffs."
            )
            build_log.info("[build] Call 2 prompt size: %d chars job_id=%s", len(call2_prompt), job_id)
            build_log.info("[build] Call 2: applying %d change requests job_id=%s max_tokens=8000 streaming",
                           len(pending_changes), job_id)
            try:
                r2_text = ""
                async with _claude.messages.stream(
                    model="claude-sonnet-4-20250514",
                    max_tokens=8000,
                    system=system_prompt,
                    messages=[{"role": "user", "content": call2_prompt}],
                ) as stream2:
                    async for text in stream2.text_stream:
                        r2_text += text
                usage2 = (await stream2.get_final_message()).usage
                c2_in  = usage2.input_tokens
                c2_out = usage2.output_tokens
                input_tokens  += c2_in
                output_tokens += c2_out
                build_log.info("[build] Call 2 complete: %d output tokens job_id=%s tokens_in=%d tokens_out=%d",
                               c2_out, job_id, c2_in, c2_out)
                try:
                    r2_result = _strip_think_and_parse(r2_text)
                    existing  = {f["path"]: i for i, f in enumerate(files)}
                    for modified_file in r2_result.get("files", []):
                        path = modified_file.get("path", "")
                        if path in existing:
                            files[existing[path]]["content"] = modified_file["content"]
                        else:
                            files.append(modified_file)
                    build_log.info("[build] Call 2 merged %d modified files job_id=%s",
                                   len(r2_result.get("files", [])), job_id)
                except Exception as parse_exc:
                    build_log.warning("[build] Call 2 JSON parse failed job_id=%s — changes not applied: %r",
                                      job_id, parse_exc)
            except Exception as exc:
                build_log.warning("[build] Call 2 failed job_id=%s — proceeding without changes: %r", job_id, exc)

    # ── Convergence point — both modes must have files here ───────────────────
    if not files:
        _fail_retryable(job_id, job, "no_files_generated", "no files were generated")
        return

    _update_build_phase(job_id, job, "injecting_assets", 88)

    # Step 4b — Inject asset data URIs into generated HTML/CSS (post-processing)
    if logo_data_uri or gallery_data_uris:
        for entry in files:
            content = entry.get("content", "")
            if logo_data_uri:
                content = content.replace(_LOGO_PH, logo_data_uri)
            for placeholder, data_uri in gallery_data_uris:
                content = content.replace(placeholder, data_uri)
            entry["content"] = content
        build_log.info("[build] Asset injection complete job_id=%s logo=%s gallery=%d",
                       job_id, bool(logo_data_uri), len(gallery_data_uris))

    # ── Gallery CMS injection ─────────────────────────────────────────────────
    if needs_gallery_admin:
        cms_script     = _gallery_cms_script(job_id)
        contact_script = _contact_cms_script(job_id)
        stock_script   = _stock_images_cms_script(job_id, stock_images, admin_token=SITE_ADMIN_TOKEN)
        admin_html     = _make_gallery_admin_html(
            job_id, business_name, admin_password, _primary_color, stock_images,
            admin_token=SITE_ADMIN_TOKEN,
        )
        for entry in files:
            path = entry.get("path", "")
            if not path.endswith(".html"):
                continue
            content = entry["content"]
            if path.endswith("gallery.html"):
                content = content.replace("</body>", f"{cms_script}\n</body>", 1) if "</body>" in content else content + cms_script
            elif path.endswith("contact.html"):
                content = content.replace("</body>", f"{contact_script}\n</body>", 1) if "</body>" in content else content + contact_script
            # Stock script injected in <head> so DOMContentLoaded fires before images load from network
            if "</head>" in content:
                entry["content"] = content.replace("</head>", f"{stock_script}\n</head>", 1)
            elif "</body>" in content:
                entry["content"] = content.replace("</body>", f"{stock_script}\n</body>", 1)
            else:
                entry["content"] = content + stock_script
        files.append({
            "path":    f"customers/{job_id}/admin/index.html",
            "content": admin_html,
        })
        build_log.info("[build] Gallery admin generated job_id=%s", job_id)

    _update_build_phase(job_id, job, "writing_files", 90)

    # Step 5 — Write files
    try:
        for entry in files:
            dest = WEBSITE_BUILDS_DIR / entry["path"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(entry["content"], encoding="utf-8")
        build_log.info("[build] Wrote %d files for job_id=%s", len(files), job_id)
    except Exception as exc:
        _fail_retryable(job_id, job, "write_files", str(exc))
        return

    _update_build_phase(job_id, job, "publishing_preview", 93)

    # Step 6 — Copy build to Caddy sites directory (BEFORE GitHub so preview is always live)
    preview_url        = ""
    preview_expires_at = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()

    try:
        caddy_site = Path(f"/srv/sites/{job_id}")
        src = WEBSITE_BUILDS_DIR / "customers" / job_id

        # Preserve user-uploaded content across rebuilds
        _preserve_names = ["images", "videos", "data", "admin"]
        _tmp_preserve   = Path(f"/tmp/caddy-preserve-{job_id}")
        _preserved: list[str] = []
        if caddy_site.exists():
            for dname in _preserve_names:
                pd = caddy_site / dname
                if pd.is_dir():
                    tpd = _tmp_preserve / dname
                    tpd.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copytree(str(pd), str(tpd))
                    _preserved.append(dname)
            shutil.rmtree(str(caddy_site))

        shutil.copytree(str(src), str(caddy_site))

        # Restore preserved dirs (uploads/projects/admin take precedence over builder output)
        for dname in _preserved:
            dst = caddy_site / dname
            if dst.exists():
                shutil.rmtree(str(dst))
            shutil.copytree(str(_tmp_preserve / dname), str(dst))
        shutil.rmtree(str(_tmp_preserve), ignore_errors=True)

        preview_url = f"https://{PREVIEW_DOMAIN}/{job_id}"
        build_log.info("[build] Preview ready job_id=%s url=%s preserved=%s", job_id, preview_url, _preserved)
    except Exception as exc:
        build_fail_log.warning("BUILD_WARNING job_id=%s step=caddy error=%s", job_id, str(exc)[:200])

    _update_build_phase(job_id, job, "pushing_github", 97)

    # Step 7 — Push to GitHub (non-blocking — failure logged but build still succeeds)
    repo_url = ""
    tmp_repo = f"/tmp/wb-{job_id}"
    if not GITHUB_PAT:
        build_fail_log.warning("SKIP_GITHUB job_id=%s reason=GITHUB_PAT_not_set", job_id)
    else:
        try:
            auth_clone_url = GITHUB_REPO.replace("https://", f"https://{GITHUB_PAT}@")
            rc, _, err = await _run_cmd(["git", "clone", auth_clone_url, tmp_repo])
            if rc != 0:
                raise RuntimeError(f"git clone: {err[:200]}")

            src = WEBSITE_BUILDS_DIR / "customers" / job_id
            dst = Path(tmp_repo) / "customers" / job_id
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                shutil.rmtree(str(dst))
            shutil.copytree(str(src), str(dst))

            for cmd in [
                ["git", "config", "user.email", "build-agent@funkfactorymediagroup.com"],
                ["git", "config", "user.name",  "FFMG Build Agent"],
                ["git", "add", f"customers/{job_id}/"],
            ]:
                rc, _, err = await _run_cmd(cmd, cwd=tmp_repo)
                if rc != 0:
                    raise RuntimeError(f"git {cmd[1]}: {err[:200]}")

            # Commit — treat "nothing to commit" as success
            commit_msg = f"Add {business_name} website — job {job_id}"
            rc, out, err = await _run_cmd(["git", "commit", "-m", commit_msg], cwd=tmp_repo)
            if rc != 0:
                nothing = "nothing to commit" in out or "nothing to commit" in err or "nothing added to commit" in out
                if nothing:
                    build_log.info("[build] GitHub: nothing to commit job_id=%s — skipping push", job_id)
                else:
                    raise RuntimeError(f"git commit: {err[:200]}")
            else:
                rc, _, err = await _run_cmd(["git", "push", "origin", "main"], cwd=tmp_repo)
                if rc != 0:
                    raise RuntimeError(f"git push: {err[:200]}")
                base_url = GITHUB_REPO.replace(".git", "")
                repo_url = f"{base_url}/tree/main/customers/{job_id}"
                build_log.info("[build] GitHub push complete job_id=%s url=%s", job_id, repo_url)
        except Exception as exc:
            build_fail_log.warning("GITHUB_PUSH_FAILED job_id=%s error=%s", job_id, str(exc)[:300])
        finally:
            shutil.rmtree(tmp_repo, ignore_errors=True)

    # Step 8 — Log cost
    input_cost  = (input_tokens  / 1_000_000) * 3.00
    output_cost = (output_tokens / 1_000_000) * 15.00
    _log_cost(job_id, business_name, "build", "claude-sonnet",
              input_tokens, output_tokens, input_cost + output_cost)

    # Backfill planning cost if not already recorded
    plan = job.get("plan", {})
    if plan.get("planned_by") == "claude-sonnet" and not _cost_entry_exists(job_id, "planning"):
        plan_chars       = len(json.dumps(plan))
        est_out_tokens   = max(1, plan_chars // 4)
        est_in_tokens    = 500
        est_cost = ((est_in_tokens / 1_000_000) * 3.00) + ((est_out_tokens / 1_000_000) * 15.00)
        _log_cost(job_id, business_name, "planning", "claude-sonnet",
                  est_in_tokens, est_out_tokens, est_cost)

    # Step 9 — Update job file
    if pending_changes:
        # Only mark applied if Claude actually produced verified output.
        # UPDATE mode: track per-file; FULL REBUILD: files written = success.
        changes_verified = (
            bool(files_actually_modified) if use_update else True
        )
        failed_indexes = []
        for i, cr in enumerate(job.get("change_requests") or []):
            if not cr.get("applied"):
                if changes_verified:
                    cr["applied"] = True
                else:
                    failed_indexes.append(i)
        if not changes_verified:
            build_log.warning(
                "[build] Changes NOT marked applied — all execute_file retries fell back job_id=%s failed=%s",
                job_id, failed_indexes,
            )
            job["failed_change_indexes"] = failed_indexes
        else:
            job.pop("failed_change_indexes", None)

    built_at = _now()
    job.update({
        "build_status":       "completed",
        "built_at":           built_at,
        "repo_url":           repo_url,
        "preview_url":        preview_url,
        "preview_expires_at": preview_expires_at,
        "package_built":      package_name,
        "pages_built":        pages_built,
        "build_summary":      summary,
        "preview_notified":   False,
        "theme_used":         site_theme,
        "colors_used":        _all_colors,
        "colors_source":      colors_source,
        "build_phase":        "complete",
        "build_progress":     100,
        "stock_images_used":  stock_images,
        "industry_detected":  industry,
    })
    _save_job(job_id, job)
    _update_index_entry(job_id, {"status": "preview_ready"})

    build_success_log.info(
        "BUILD_SUCCESS job_id=%s preview=%s repo=%s", job_id, preview_url, repo_url
    )

    # Step 10 — POST preview to Polsia
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(
                POLSIA_PREVIEW_URL,
                headers={
                    "Content-Type":    "application/json",
                    "X-Polsia-Secret": POLSIA_SECRET,
                },
                json={
                    "job_id":             job_id,
                    "customer_uuid":      customer_uuid,
                    "status":             "preview_ready",
                    "preview_url":        preview_url,
                    "preview_expires_at": preview_expires_at,
                    "package":            package_name,
                    "pages_built":        pages_built,
                    "built_at":           built_at,
                    "notes":              f"GitHub: {repo_url}" if repo_url else "",
                },
            )
            r.raise_for_status()
            job["preview_notified"] = True
            _save_job(job_id, job)
            build_log.info("[build] Preview notified Polsia for job_id=%s", job_id)
    except Exception as exc:
        build_fail_log.warning(
            "POLSIA_NOTIFY_FAILED job_id=%s error=%s", job_id, str(exc)[:200]
        )

    build_log.info("[build] Complete for job_id=%s — preview at %s", job_id, preview_url)


# ── Router ────────────────────────────────────────────────────────────────────

router = APIRouter(tags=["build"])


class BuildTriggerRequest(BaseModel):
    job_id: str
    force_claude: bool = False
    build_mode: str = "messages_api"
    rebuild_mode: str = "update"  # "update" | "full"


@router.post("/build/trigger")
async def trigger_build(
    req: BuildTriggerRequest,
    background_tasks: BackgroundTasks,
    _=Depends(verify_assistant_key),
):
    index_entry = _find_index_entry(req.job_id)
    if not index_entry:
        raise HTTPException(status_code=404, detail="job_id not found")

    job = _load_job(req.job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job file not found")

    if index_entry.get("status") != "approved":
        raise HTTPException(
            status_code=422,
            detail="Job must have status approved before building",
        )

    now = _now()
    job.update({
        "build_status":       "in_development",
        "build_triggered_at": now,
        "force_claude":       req.force_claude,
    })
    _save_job(req.job_id, job)
    _update_index_entry(req.job_id, {"status": "in_development"})

    background_tasks.add_task(build_website, req.job_id, req.force_claude, req.build_mode, req.rebuild_mode)

    return {
        "triggered":     True,
        "job_id":        req.job_id,
        "customer_uuid": job.get("customer_uuid", ""),
        "force_claude":  req.force_claude,
        "build_mode":    req.build_mode,
        "rebuild_mode":  req.rebuild_mode,
        "message":       "Build started",
    }


class BuildExistingRequest(BaseModel):
    job_id: str
    customer_uuid: Optional[str] = None
    repo_path: str
    business_name: str
    package: str = "standard"


@router.post("/build/existing")
async def build_existing(req: BuildExistingRequest, _=Depends(verify_assistant_key)):
    now              = _now()
    customer_uuid    = req.customer_uuid or str(uuid.uuid4())
    base_repo_url    = GITHUB_REPO.replace(".git", "")
    repo_url         = f"{base_repo_url}/tree/main/{req.repo_path}"
    preview_expires_at = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()

    # Step 1 — Clone repo and verify repo_path exists
    tmp_repo = f"/tmp/wb-existing-{req.job_id}"
    shutil.rmtree(tmp_repo, ignore_errors=True)

    if not GITHUB_PAT:
        raise HTTPException(status_code=500, detail="GITHUB_PAT not configured")

    auth_clone_url = GITHUB_REPO.replace("https://", f"https://{GITHUB_PAT}@")

    rc, _, err = await _run_cmd(["git", "clone", auth_clone_url, tmp_repo])
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"git clone failed: {err[:200]}")

    repo_path_inside = Path(tmp_repo) / req.repo_path
    build_log.info("[build/existing] checking repo_path_inside=%s exists=%s", repo_path_inside, repo_path_inside.exists())
    try:
        root_contents = list(Path(tmp_repo).iterdir())
        build_log.info("[build/existing] repo root (%d items): %s", len(root_contents), [p.name for p in root_contents])
    except Exception as _e:
        build_log.warning("[build/existing] could not list repo root: %s", _e)
    _, ls_out, _ = await _run_cmd(["ls", "-la", tmp_repo])
    build_log.info("[build/existing] ls %s:\n%s", tmp_repo, ls_out[:1000])

    if not repo_path_inside.exists():
        shutil.rmtree(tmp_repo, ignore_errors=True)
        raise HTTPException(status_code=404, detail=f"repo_path '{req.repo_path}' not found in repository")

    dest_dir = WEBSITE_BUILDS_DIR / req.repo_path

    # Preserve gallery data and uploads across re-deploys
    tmp_preserve = Path(f"/tmp/preserve-{req.job_id}")
    preserved_dirs: list[str] = []
    if dest_dir.exists():
        for pname in ("data", "uploads"):
            pd = dest_dir / pname
            if pd.is_dir():
                tpd = tmp_preserve / pname
                tpd.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(str(pd), str(tpd))
                preserved_dirs.append(pname)
        shutil.rmtree(str(dest_dir))

    shutil.copytree(str(repo_path_inside), str(dest_dir))
    shutil.rmtree(tmp_repo, ignore_errors=True)

    # Restore preserved data/uploads
    for pname in preserved_dirs:
        dst = dest_dir / pname
        if dst.exists():
            shutil.rmtree(str(dst))
        shutil.copytree(str(tmp_preserve / pname), str(dst))
    shutil.rmtree(str(tmp_preserve), ignore_errors=True)

    # Ensure data/ and uploads/ dirs exist for the API
    (dest_dir / "data").mkdir(exist_ok=True)
    (dest_dir / "uploads").mkdir(exist_ok=True)

    build_log.info("[build/existing] Copied %s to %s", req.repo_path, dest_dir)

    # Step 2 — Build site and copy to /srv/sites/{job_id}/ for Caddy
    # No HTTP server or tunnel needed — Caddy serves /srv/sites/ directly.
    import subprocess as _sp

    site_dir = dest_dir / "site"
    preview_url = ""

    try:
        if site_dir.is_dir() and (site_dir / "package.json").exists():
            # React / Vite app — npm install + build
            build_log.info("[build/existing] React app detected job_id=%s — installing", req.job_id)
            install_cmd = ["npm", "ci"] if (site_dir / "package-lock.json").exists() else ["npm", "install"]
            npm_install = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: _sp.run(install_cmd, cwd=str(site_dir),
                                capture_output=True, text=True, timeout=120),
            )
            if npm_install.returncode != 0:
                build_log.error("[build/existing] npm install failed job_id=%s:\n%s",
                                req.job_id, npm_install.stderr[:500])
                raise HTTPException(status_code=500,
                                    detail=f"npm install failed: {npm_install.stderr[:300]}")

            # Patch vite.config.js/ts to set base path so assets resolve
            # correctly when served from /job_id/ instead of /
            for vite_cfg_name in ("vite.config.js", "vite.config.ts"):
                vite_cfg = site_dir / vite_cfg_name
                if vite_cfg.exists():
                    cfg_text = vite_cfg.read_text(encoding="utf-8")
                    if "base:" not in cfg_text:
                        patched = cfg_text.replace(
                            "defineConfig({",
                            f"defineConfig({{\n  base: '/{req.job_id}/',",
                        )
                        vite_cfg.write_text(patched, encoding="utf-8")
                        build_log.info("[build/existing] Patched %s base=/%s/ job_id=%s",
                                       vite_cfg_name, req.job_id, req.job_id)
                    else:
                        build_log.info("[build/existing] %s already has base: set — skipping patch job_id=%s",
                                       vite_cfg_name, req.job_id)
                    break

            build_log.info("[build/existing] npm build starting job_id=%s", req.job_id)
            npm_build = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: _sp.run(["npm", "run", "build"], cwd=str(site_dir),
                                env={**os.environ}, capture_output=True, text=True, timeout=300),
            )
            if npm_build.returncode != 0:
                build_log.error("[build/existing] npm build failed job_id=%s:\n%s",
                                req.job_id, npm_build.stderr[:500])
                raise HTTPException(status_code=500,
                                    detail=f"npm build failed: {npm_build.stderr[:300]}")

            if (site_dir / "dist").is_dir():
                serve_dir = site_dir / "dist"
            elif (site_dir / "build").is_dir():
                serve_dir = site_dir / "build"
            else:
                build_log.error("[build/existing] No dist/ or build/ after npm build job_id=%s contents=%s",
                                req.job_id, [p.name for p in site_dir.iterdir()])
                raise HTTPException(status_code=500,
                                    detail="Build output (dist/ or build/) not found after npm build")

            build_log.info("[build/existing] React build complete — dist at %s", serve_dir)

        elif site_dir.is_dir() and (site_dir / "index.html").exists():
            # Plain static HTML — no build step
            serve_dir = site_dir
            build_log.info("[build/existing] Static HTML site detected job_id=%s — copying site/ directly", req.job_id)

        else:
            # Fallback: treat repo root as serve root
            serve_dir = dest_dir
            build_log.info("[build/existing] Falling back to repo root job_id=%s serve_dir=%s", req.job_id, serve_dir)

        # Copy built files to Caddy sites directory
        caddy_site = Path(f"/srv/sites/{req.job_id}")
        if caddy_site.exists():
            shutil.rmtree(str(caddy_site))
        shutil.copytree(str(serve_dir), str(caddy_site))
        preview_url = f"https://{PREVIEW_DOMAIN}/{req.job_id}"
        build_log.info("[build/existing] Preview ready job_id=%s url=%s caddy_site=%s",
                       req.job_id, preview_url, caddy_site)

        # Vite public/ assets land at dist/ root and are referenced without the
        # base prefix (e.g. /logo.png, not /bullscapes-001/logo.png).
        # Copy them to /srv/sites/ root so Caddy serves them at the bare path.
        _ASSET_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".ico"}
        srv_root = Path("/srv/sites")
        srv_root.mkdir(parents=True, exist_ok=True)
        root_assets = [p for p in serve_dir.iterdir() if p.is_file() and p.suffix.lower() in _ASSET_EXTS]
        for asset in root_assets:
            shutil.copy2(str(asset), str(srv_root / asset.name))
        if root_assets:
            build_log.info("[build/existing] Copied %d public assets to /srv/sites/ root: %s",
                           len(root_assets), [a.name for a in root_assets])

    except HTTPException:
        raise  # propagate 4xx/5xx to caller
    except Exception as exc:
        build_log.error("[build/existing] Unexpected error job_id=%s error=%r", req.job_id, exc)
        raise HTTPException(status_code=500, detail=f"Build failed: {str(exc)[:300]}")

    # Step 3 — Write job file and index
    job_record = {
        "job_id":             req.job_id,
        "customer_uuid":      customer_uuid,
        "business_name":      req.business_name,
        "source":             "existing_build",
        "status":             "preview_ready",
        "build_status":       "completed",
        "built_at":           now,
        "repo_url":           repo_url,
        "preview_url":        preview_url,
        "preview_expires_at": preview_expires_at,
        "package_built":      req.package,
        "preview_notified":   False,
        "received_at":        now,
    }
    _save_job(req.job_id, job_record)

    # Upsert index — update if exists, append if new
    if _find_index_entry(req.job_id):
        _update_index_entry(req.job_id, {
            "customer_uuid": customer_uuid,
            "client":        req.business_name,
            "status":        "preview_ready",
            "planned_by":    "existing_build",
        })
    else:
        with open(INTAKE_JOBS_DIR / "index.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "job_id":        req.job_id,
                "customer_uuid": customer_uuid,
                "client":        req.business_name,
                "status":        "preview_ready",
                "created_at":    now,
                "planned_by":    "existing_build",
            }) + "\n")

    build_log.info("[build/existing] Job record saved job_id=%s", req.job_id)

    # Step 4 — Notify Polsia
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(
                POLSIA_PREVIEW_URL,
                headers={"Content-Type": "application/json", "X-Polsia-Secret": POLSIA_SECRET},
                json={
                    "job_id":             req.job_id,
                    "customer_uuid":      customer_uuid,
                    "status":             "preview_ready",
                    "preview_url":        preview_url,
                    "preview_expires_at": preview_expires_at,
                    "package":            req.package,
                    "pages_built":        ["existing build"],
                    "built_at":           now,
                    "notes":              f"Existing build from repo path: {req.repo_path}",
                },
            )
            r.raise_for_status()
            job_record["preview_notified"] = True
            _save_job(req.job_id, job_record)
            build_log.info("[build/existing] Polsia notified job_id=%s", req.job_id)
    except Exception as exc:
        build_log.warning("[build/existing] Polsia notify failed job_id=%s error=%s", req.job_id, exc)

    # Step 5 — Return
    return {
        "triggered":          True,
        "job_id":             req.job_id,
        "customer_uuid":      customer_uuid,
        "repo_path":          req.repo_path,
        "preview_url":        preview_url,
        "preview_expires_at": preview_expires_at,
        "repo_url":           repo_url,
        "message":            "Existing build preview started",
    }


@router.get("/build/republish/{job_id}")
async def republish_build(job_id: str, _=Depends(verify_assistant_key)):
    """Re-copy existing build to /srv/sites without regenerating. Zero Claude cost."""
    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job_id not found")

    output_dir = WEBSITE_BUILDS_DIR / "customers" / job_id
    if not (output_dir / "index.html").exists():
        raise HTTPException(status_code=404, detail="No existing build files found for this job")

    try:
        caddy_site = Path(f"/srv/sites/{job_id}")
        if caddy_site.exists():
            shutil.rmtree(str(caddy_site))
        shutil.copytree(str(output_dir), str(caddy_site))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to copy files: {str(exc)[:200]}")

    preview_url        = f"https://{PREVIEW_DOMAIN}/{job_id}"
    preview_expires_at = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    built_at           = _now()

    job.update({
        "preview_url":        preview_url,
        "preview_expires_at": preview_expires_at,
        "build_status":       "completed",
        "built_at":           built_at,
        "build_phase":        "complete",
        "build_progress":     100,
    })
    _save_job(job_id, job)
    _update_index_entry(job_id, {"status": "preview_ready"})
    build_log.info("[build/republish] job_id=%s url=%s", job_id, preview_url)

    return {
        "republished":        True,
        "job_id":             job_id,
        "preview_url":        preview_url,
        "preview_expires_at": preview_expires_at,
    }


@router.delete("/build/preview/{job_id}")
async def kill_preview(job_id: str, _=Depends(verify_assistant_key)):
    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job_id not found")

    # Remove files — Caddy serves /srv/sites directly so deletion is sufficient
    shutil.rmtree(f"/srv/sites/{job_id}", ignore_errors=True)

    # Update job file
    job["preview_url"]       = None
    job["preview_killed_at"] = _now()
    job["build_status"]      = "preview_killed"
    _save_job(job_id, job)
    _update_index_entry(job_id, {"status": "preview_killed"})

    build_log.info("[build] Preview killed job_id=%s", job_id)
    return {"killed": True, "job_id": job_id, "message": "Preview removed"}


@router.get("/intake/costs/summary")
async def intake_costs_summary(_=Depends(verify_assistant_key)):
    costs_path = INTAKE_COSTS_DIR / "costs.jsonl"

    _empty = {
        "summary": {
            "total_spend_usd":           0.0,
            "this_month_spend_usd":       0.0,
            "average_cost_per_job_usd":   0.0,
            "total_jobs_processed":        0,
            "total_input_tokens":          0,
            "total_output_tokens":         0,
        },
        "model_usage": {},
        "jobs": [],
    }

    if not costs_path.exists():
        return _empty

    records = []
    for line in costs_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except Exception:
            continue

    if not records:
        return _empty

    this_month = datetime.now(timezone.utc).strftime("%Y-%m")
    total_spend         = 0.0
    this_month_spend    = 0.0
    total_input_tokens  = 0
    total_output_tokens = 0
    job_ids: set        = set()
    model_usage: dict   = defaultdict(lambda: {"count": 0, "total_cost_usd": 0.0})

    for rec in records:
        cost   = float(rec.get("cost_usd", 0))
        logged = (rec.get("logged_at") or "")[:7]
        model  = rec.get("model_used", "unknown")
        jid    = rec.get("job_id", "")

        total_spend         += cost
        total_input_tokens  += int(rec.get("input_tokens", 0))
        total_output_tokens += int(rec.get("output_tokens", 0))
        job_ids.add(jid)
        model_usage[model]["count"] += 1
        model_usage[model]["total_cost_usd"] = round(
            model_usage[model]["total_cost_usd"] + cost, 6
        )
        if logged == this_month:
            this_month_spend += cost

    total_jobs = len(job_ids)
    avg_cost   = (total_spend / total_jobs) if total_jobs else 0.0

    return {
        "summary": {
            "total_spend_usd":           round(total_spend, 4),
            "this_month_spend_usd":       round(this_month_spend, 4),
            "average_cost_per_job_usd":   round(avg_cost, 4),
            "total_jobs_processed":        total_jobs,
            "total_input_tokens":          total_input_tokens,
            "total_output_tokens":         total_output_tokens,
        },
        "model_usage": {
            k: {"count": v["count"], "total_cost_usd": round(v["total_cost_usd"], 4)}
            for k, v in model_usage.items()
        },
        "jobs": [
            {
                "job_id":        r.get("job_id"),
                "business_name": r.get("business_name"),
                "operation":     r.get("operation"),
                "model_used":    r.get("model_used"),
                "input_tokens":  r.get("input_tokens", 0),
                "output_tokens": r.get("output_tokens", 0),
                "cost_usd":      round(float(r.get("cost_usd", 0)), 4),
                "logged_at":     r.get("logged_at"),
            }
            for r in records
        ],
    }


class ResetChangesRequest(BaseModel):
    indexes: list  # list of int indexes into change_requests to reset to applied=False


@router.post("/admin/jobs/{job_id}/reset-changes")
async def reset_changes(job_id: str, req: ResetChangesRequest, _=Depends(verify_assistant_key)):
    """Reset specified change_requests back to applied=False so they can be retried."""
    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job_id not found")
    crs = job.get("change_requests") or []
    reset = []
    for idx in req.indexes:
        if isinstance(idx, int) and 0 <= idx < len(crs):
            crs[idx]["applied"] = False
            reset.append(idx)
    job["change_requests"] = crs
    job.pop("failed_change_indexes", None)
    _save_job(job_id, job)
    build_log.info("[admin] reset-changes job_id=%s reset_indexes=%s", job_id, reset)
    return {"reset": True, "job_id": job_id, "indexes_reset": reset}


@router.get("/jobs/{job_id}/status")
async def job_status(job_id: str, _=Depends(verify_assistant_key)):
    job = _load_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job_id not found")

    brief         = job.get("original_brief", {})
    contact       = brief.get("contact", {})
    index_entry   = _find_index_entry(job_id)
    status        = (index_entry or {}).get("status", "unknown")

    return {
        "job_id":              job_id,
        "customer_uuid":       job.get("customer_uuid"),
        "business_name":       contact.get("business_name"),
        "status":              status,
        "build_status":        job.get("build_status"),
        "build_triggered_at":  job.get("build_triggered_at"),
        "built_at":            job.get("built_at"),
        "preview_url":         job.get("preview_url"),
        "preview_expires_at":  job.get("preview_expires_at"),
        "repo_url":            job.get("repo_url"),
        "package_built":       job.get("package_built"),
        "pages_built":         job.get("pages_built"),
        "preview_notified":    job.get("preview_notified", False),
        "planned_by":          (job.get("plan") or {}).get("planned_by"),
    }


# ── Site admin token auth ──────────────────────────────────────────────────────

SITE_ADMIN_TOKEN = os.getenv("SITE_ADMIN_TOKEN", "trejo-admin-2026-secure")
SITES_DIR        = Path("/srv/sites")

_IMG_EXTS = {
    "image/jpeg":  "jpg",
    "image/jpg":   "jpg",
    "image/png":   "png",
    "image/webp":  "webp",
    "image/gif":   "gif",
    "image/avif":  "avif",
}


async def verify_site_admin(x_admin_token: Optional[str] = Header(None)) -> str:
    if not x_admin_token:
        raise HTTPException(status_code=401, detail="X-Admin-Token header required")
    assistant_key = os.getenv("ASSISTANT_API_KEY", "")
    ok = (
        (assistant_key and hmac.compare_digest(x_admin_token, assistant_key))
        or hmac.compare_digest(x_admin_token, SITE_ADMIN_TOKEN)
    )
    if not ok:
        raise HTTPException(status_code=401, detail="Invalid admin token")
    return x_admin_token


def _site_images_dir(job_id: str, subdir: str = "") -> Path:
    base = SITES_DIR / job_id / "images"
    if subdir:
        base = base / subdir
    base.mkdir(parents=True, exist_ok=True)
    return base


# ── GET /sites/{job_id}/images ────────────────────────────────────────────────

@router.get("/sites/{job_id}/images")
async def list_site_images(
    job_id: str,
    _: str = Depends(verify_site_admin),
):
    images_dir = SITES_DIR / job_id / "images"
    images: dict = {}
    if images_dir.exists():
        for f in sorted(images_dir.iterdir()):
            if f.is_file() and f.suffix.lower().lstrip(".") in ("jpg", "jpeg", "png", "webp", "gif", "avif"):
                images[f.stem] = f"/{job_id}/images/{f.name}"
    return {"images": images}


# ── POST /sites/{job_id}/images ───────────────────────────────────────────────

@router.post("/sites/{job_id}/images")
async def upload_site_image(
    job_id: str,
    slot: str = Form(...),
    file: UploadFile = File(...),
    subdir: str = Form(""),
    _: str = Depends(verify_site_admin),
):
    ct  = (file.content_type or "image/jpeg").split(";")[0].strip()
    ext = _IMG_EXTS.get(ct, "jpg")

    images_dir = _site_images_dir(job_id, subdir)

    # Remove any existing file for this slot (regardless of extension)
    for old in images_dir.glob(f"{slot}.*"):
        old.unlink(missing_ok=True)

    dest = images_dir / f"{slot}.{ext}"
    dest.write_bytes(await file.read())

    url_path = f"/{job_id}/images/{subdir + '/' if subdir else ''}{slot}.{ext}"
    build_log.info("[site-images] uploaded job_id=%s slot=%s path=%s", job_id, slot, dest)
    return {"saved": True, "slot": slot, "url": url_path}


# ── DELETE /sites/{job_id}/images/{slot} ─────────────────────────────────────

@router.delete("/sites/{job_id}/images/{slot}")
async def delete_site_image(
    job_id: str,
    slot: str,
    subdir: str = "",
    _: str = Depends(verify_site_admin),
):
    images_dir = SITES_DIR / job_id / "images"
    if subdir:
        images_dir = images_dir / subdir
    deleted = False
    for f in images_dir.glob(f"{slot}.*"):
        f.unlink(missing_ok=True)
        deleted = True
    return {"deleted": deleted, "slot": slot}


# ── POST /sites/{job_id}/videos ──────────────────────────────────────────────

_VIDEO_EXTS = {
    "video/mp4":       "mp4",
    "video/quicktime": "mov",
    "video/webm":      "webm",
    "video/x-msvideo": "avi",
}

@router.post("/sites/{job_id}/videos")
async def upload_site_video(
    job_id: str,
    slot: str = Form(...),
    file: UploadFile = File(...),
    subdir: str = Form("projects"),
    _: str = Depends(verify_site_admin),
):
    ct  = (file.content_type or "video/mp4").split(";")[0].strip()
    ext = _VIDEO_EXTS.get(ct, "mp4")

    videos_dir = SITES_DIR / job_id / "videos"
    if subdir:
        videos_dir = videos_dir / subdir
    videos_dir.mkdir(parents=True, exist_ok=True)

    for old in videos_dir.glob(f"{slot}.*"):
        old.unlink(missing_ok=True)

    dest = videos_dir / f"{slot}.{ext}"
    dest.write_bytes(await file.read())

    url_path = f"/{job_id}/videos/{subdir + '/' if subdir else ''}{slot}.{ext}"
    build_log.info("[site-videos] uploaded job_id=%s slot=%s path=%s", job_id, slot, dest)
    return {"saved": True, "slot": slot, "url": url_path}


# ── GET /sites/{job_id}/projects  (public — no auth) ─────────────────────────

@router.get("/sites/{job_id}/projects")
async def get_site_projects(job_id: str):
    data_file = SITES_DIR / job_id / "data" / "projects.json"
    if not data_file.exists():
        return {"projects": []}
    try:
        return {"projects": json.loads(data_file.read_text(encoding="utf-8"))}
    except Exception:
        return {"projects": []}


# ── POST /sites/{job_id}/projects ────────────────────────────────────────────

@router.post("/sites/{job_id}/projects")
async def save_site_projects(
    job_id: str,
    projects: List[dict],
    _: str = Depends(verify_site_admin),
):
    data_dir = SITES_DIR / job_id / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "projects.json").write_text(
        json.dumps(projects, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    build_log.info("[site-projects] saved job_id=%s count=%d", job_id, len(projects))
    return {"saved": True, "count": len(projects)}
