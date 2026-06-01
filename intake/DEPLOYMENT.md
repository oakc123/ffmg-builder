# Polsia Job Intake — Deployment

## Prerequisites
- Python 3.11+
- Access to 192.168.0.235
- Anthropic API key
- Polsia shared secret (set the same value in Polsia's webhook config)

---

## Steps

### 1. SSH into the server
```bash
ssh achild@192.168.0.235
```

### 2. Clone or copy the directory
```bash
git clone <repo-url> personal-assistant-intake
# or
scp -r personal-assistant-intake/ achild@192.168.0.235:~/
```

### 3. Enter the directory
```bash
cd personal-assistant-intake
```

### 4. Configure environment
```bash
cp .env.example .env
nano .env
```
Fill in:
- `ANTHROPIC_API_KEY` — your Anthropic API key
- `POLSIA_SECRET` — a strong random string (share this with Polsia to put in their webhook header)
- `OLLAMA_HOST` — default `http://192.168.0.18:11434` (change if Ollama moved)

### 5. Install dependencies
```bash
pip install -r requirements.txt
```

### 6. Start the server
```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

For production (background, auto-restart):
```bash
nohup uvicorn main:app --host 0.0.0.0 --port 8000 --workers 2 > logs/uvicorn.log 2>&1 &
```

Or add a systemd service:
```ini
[Unit]
Description=Polsia Job Intake
After=network.target

[Service]
WorkingDirectory=/home/achild/personal-assistant-intake
ExecStart=/usr/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8000
Restart=always
User=achild

[Install]
WantedBy=multi-user.target
```

---

## 7. Expose via Cloudflare Tunnel

> The existing tunnel (serving n8n.funkfactorymediagroup.com) handles this — no tunnel binary changes needed.

1. Log into [Cloudflare Zero Trust dashboard](https://one.cloudflare.com)
2. Navigate to **Networks → Tunnels**
3. Select your existing tunnel (the one serving `n8n.funkfactorymediagroup.com`)
4. Click **Public Hostnames → Add a public hostname**
5. Fill in:
   - **Subdomain:** `intake`
   - **Domain:** `funkfactorymediagroup.com`
   - **Service Type:** `HTTP`
   - **URL:** `localhost:8000`
6. Click **Save** — no tunnel restart needed

The endpoint will be live at:
`https://intake.funkfactorymediagroup.com/jobs/intake`

---

## 8. Test

Health check:
```bash
curl https://intake.funkfactorymediagroup.com/health
```

Full intake test:
```bash
curl -X POST https://intake.funkfactorymediagroup.com/jobs/intake \
  -H "Content-Type: application/json" \
  -H "X-Polsia-Secret: your_secret_here" \
  -d @test_payload.json
```

Local test (before tunnel):
```bash
curl -X POST http://localhost:8000/jobs/intake \
  -H "Content-Type: application/json" \
  -H "X-Polsia-Secret: your_secret_here" \
  -d @test_payload.json
```

---

## Log files

| File | Purpose |
|------|---------|
| `logs/intake.log` | All intake requests, successes |
| `logs/rejected.log` | Auth failures, validation rejections, QC failures |
| `logs/claude_failures.log` | Claude API timeouts / malformed responses |
| `logs/critical_failures.log` | Both engines failed — requires manual review |

Saved jobs: `jobs/<job_id>.json`
Job index: `jobs/index.jsonl`
