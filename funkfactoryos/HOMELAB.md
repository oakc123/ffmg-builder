# FunkFactoryOS — Homelab Self-Hosting Guide

Self-host the full FunkFactoryOS stack (Express + PostgreSQL) on your homelab using Docker Compose.

---

## Prerequisites

- Docker ≥ 20.10
- Docker Compose ≥ 2.x (`docker compose` — not the legacy `docker-compose`)
- Git

Verify:
```bash
docker --version
docker compose version
```

---

## Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/Polsia-Inc/funkfactoryos.git
cd funkfactoryos
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set **at minimum**:

| Variable | What it does | Required |
|---|---|---|
| `POSTGRES_PASSWORD` | Postgres superuser password | ✅ |
| `ADMIN_PASSWORD` | Admin panel login password | ✅ |
| `JWT_SECRET` | JWT signing secret (min 32 chars) | ✅ |
| `STRIPE_SECRET_KEY` | Stripe live/test key | Only for payments |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook secret | Only for payments |
| `OWNER_EMAIL` | Where order emails go | Only for email alerts |
| `SMTP_*` | SMTP credentials | Only for email alerts |

Generate a strong JWT secret:
```bash
openssl rand -hex 32
```

### 3. Build and start

```bash
docker compose up -d --build
```

First run takes 1–2 minutes (downloads images, installs deps, runs migrations).

### 4. Verify

```bash
# Check both containers are healthy
docker compose ps

# Check app logs
docker compose logs app --tail=50

# Hit the health endpoint
curl http://localhost:3000/health
```

You should see `{"status":"ok"}` (or similar) from the health endpoint.

The app is now running at **http://localhost:3000**.

---

## Ports

| Service | Default host port | Override with |
|---|---|---|
| App | `3000` | `APP_PORT=8080` in `.env` |
| Postgres | `5432` | Edit `docker-compose.yml` |

---

## Data Persistence

Both critical data stores are mounted as named Docker volumes — they survive container restarts, rebuilds, and `docker compose down`:

| Volume | What's stored |
|---|---|
| `postgres_data` | All database tables (orders, products, gallery, etc.) |
| `uploads_data` | Uploaded images (`public/uploads/`) |

> **Note:** `docker compose down -v` deletes volumes. Never run that unless you intend to wipe all data.

---

## Updating

Pull the latest code and rebuild:

```bash
git pull
docker compose up -d --build
```

Migrations run automatically on startup — new schema changes apply themselves.

---

## Migrating Data from the Hosted Version (funkfactoryos.polsia.app)

If you want to move your existing data from the hosted Render instance to your homelab:

### Export from production

You'll need the Render database connection string from your Render dashboard (or ask support).

```bash
# Dump from production (replace <PROD_DATABASE_URL> with actual URL)
pg_dump "<PROD_DATABASE_URL>" \
  --no-owner \
  --no-acl \
  --format=plain \
  -f funkfactoryos_backup.sql
```

### Import into your local stack

Make sure your homelab stack is running first (`docker compose up -d`), then:

```bash
# Copy the dump file into the db container
docker compose exec -T db psql \
  -U postgres \
  -d funkfactoryos \
  < funkfactoryos_backup.sql
```

### Migrate uploaded images

If you have images uploaded via the admin panel that you want to copy over, they live in `public/uploads/` on the Render instance. You'll need to download them separately (via the Render dashboard file browser, or contact support for a tarball) and copy them into the `uploads_data` volume:

```bash
# Copy a local uploads folder into the running container
docker cp ./uploads/. funkfactoryos-app-1:/app/public/uploads/
```

---

## Stopping / Starting

```bash
# Stop (data preserved)
docker compose stop

# Start again
docker compose start

# Stop and remove containers (data preserved in volumes)
docker compose down

# Full wipe including all data — DESTRUCTIVE
docker compose down -v
```

---

## Accessing the Database Directly

The Postgres port is exposed on `localhost:5432`. Connect with any client:

```bash
# psql
psql -h localhost -U postgres -d funkfactoryos

# Or via docker exec
docker compose exec db psql -U postgres -d funkfactoryos
```

---

## Admin Panel

Visit `http://localhost:3000/admin.html` and log in with your `ADMIN_PASSWORD`.

---

## Logs

```bash
# All services
docker compose logs -f

# App only
docker compose logs -f app

# Postgres only
docker compose logs -f db
```

---

## Reverse Proxy (Nginx / Traefik)

To expose the app on a custom domain or port 80/443, put a reverse proxy in front.

**Nginx example snippet:**
```nginx
server {
    listen 80;
    server_name funkfactory.local;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

**Traefik label example** (in `docker-compose.yml` under `app:`):
```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.ffmg.rule=Host(`funkfactory.local`)"
  - "traefik.http.services.ffmg.loadbalancer.server.port=3000"
```

---

## Stripe Webhooks (Local)

For Stripe webhooks to reach your homelab, use the Stripe CLI to forward events:

```bash
stripe listen --forward-to localhost:3000/api/pets/stripe-webhook
```

The CLI prints a webhook signing secret — set that as `STRIPE_WEBHOOK_SECRET` in your `.env`.

---

## Troubleshooting

**App won't start — `DATABASE_URL` error**
The db container isn't healthy yet. Check: `docker compose logs db`. Usually resolves in a few seconds.

**Port 5432 already in use**
A local Postgres is running. Either stop it (`brew services stop postgresql`) or change the Postgres port in `docker-compose.yml`.

**`Cannot connect to the Docker daemon`**
Docker Desktop isn't running. Start it.

**Uploads not showing after restore**
Make sure the uploads are in the volume, not just the container filesystem. Use `docker cp` as shown above.

**SSL connection errors on a custom external Postgres**
If you point `DATABASE_URL` at an external Postgres without SSL, append `?sslmode=disable` to the URL in `docker-compose.yml`.
