# Deployment

Architecture:

- **Frontend** → Vercel (`https://sinaqriyaziyyat.vercel.app`), auto-built from the `Examapp-frontend` repo.
- **Backend** → Hetzner Cloud VPS, running in Docker behind Caddy (automatic HTTPS).
- **Database** → MongoDB Atlas.

The frontend is HTTPS, so the backend must be HTTPS too (browsers block HTTPS→HTTP
calls, and the auth cookie is `SameSite=None; Secure`). Caddy issues a free Let's
Encrypt certificate. With no custom domain you can use **sslip.io** (any IP resolves
via `<ip>.sslip.io`); swap in a real domain later by changing `SITE_ADDRESS`.

---

## 1. Backend on Hetzner

### 1.1 Create the server
- Hetzner Cloud → new project → **Add Server**.
- Image: **Ubuntu 24.04**. Type: **CX22** (2 vCPU / 4 GB) is plenty.
- Add your SSH key. Create. Note the public IPv4 (e.g. `5.75.1.2`).

### 1.2 Install Docker
SSH in (`ssh root@SERVER_IP`) and run:

```bash
curl -fsSL https://get.docker.com | sh
```

### 1.3 Open the firewall
If you enabled Hetzner Cloud Firewall (or ufw), allow inbound **22, 80, 443**.

### 1.4 Get the code and configure
```bash
git clone https://github.com/rufi-dev/Examapp-backend.git
cd Examapp-backend
cp .env.example .env
nano .env        # fill in real values (see below)
```

Key values in `.env`:
- `MONGO_URI` — your Atlas connection string.
- `SITE_ADDRESS` — `<SERVER_IP>.sslip.io`, e.g. `5.75.1.2.sslip.io` (no `https://`).
- `FRONTEND_URL` — `https://sinaqriyaziyyat.vercel.app`.
- `JWT_SECRET`, `CRYPTR_KEY` — long random strings (`openssl rand -hex 32`).
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, email SMTP vars, `STRIPE_KEY`.

### 1.5 Launch
```bash
docker compose up -d --build
```

Caddy will fetch a certificate within a few seconds. Verify:

```bash
docker compose ps
docker compose logs -f caddy     # watch for the certificate being obtained
curl https://<SERVER_IP>.sslip.io/   # should return "Home page"
```

### 1.6 Atlas network access
In Atlas → **Network Access**, allow the Hetzner server IP (or `0.0.0.0/0` for any,
less strict). Otherwise the backend can't connect to the database.

---

## 2. Frontend on Vercel

1. Vercel → **New Project** → import `rufi-dev/Examapp-frontend`.
2. Framework preset: **Vite** (auto-detected). Build `npm run build`, output `dist`.
3. **Environment Variables** (from `.env.example`):
   - `VITE_BACKEND_URL=https://<SERVER_IP>.sslip.io`
   - `VITE_GOOGLE_CLIENT_ID`, `VITE_CLOUD_NAME`, `VITE_UPLAD_PRESET`
   - `VITE_DEVELOPMENT_STATUS=production`
4. Deploy. `vercel.json` rewrites all paths to `index.html` so client-side routes
   (refresh / deep links) work.

The CORS allowlist in `server.js` already permits `https://sinaqriyaziyyat.vercel.app`.
If you add a custom domain on Vercel, add it to that allowlist too.

---

## 3. Google OAuth

In Google Cloud Console → Credentials → your OAuth client:
- **Authorized JavaScript origins**: add `https://sinaqriyaziyyat.vercel.app`.

---

## 4. Updating after a push

```bash
cd Examapp-backend
git pull
docker compose up -d --build
```

The frontend redeploys automatically on every push to the repo's production branch.

---

## 5. Switching to a real domain later

1. Point an A-record (e.g. `api.yourdomain.com`) at the server IP.
2. Set `SITE_ADDRESS=api.yourdomain.com` in `.env`, `docker compose up -d`.
3. Update Vercel `VITE_BACKEND_URL` to `https://api.yourdomain.com` and redeploy.
