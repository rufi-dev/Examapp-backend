# Backend (Express) image for Hetzner.
# AUD-012: current supported LTS (Node 22 "Jod") — Node 18 is EOL, and
# Node 24-alpine (satisfies express-handlebars 9's >=22.22.2). Pinned to match the
# dev + CI toolchain (npm 11) so the committed lockfile installs identically everywhere
# — avoids the npm-10/11 resolver skew that otherwise breaks `npm ci` on a clean build.
FROM node:24-alpine

WORKDIR /app

# Chromium + libs for whatsapp-web.js (Puppeteer). Use the system Chromium
# instead of Puppeteer's bundled download (no Alpine build exists).
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tzdata \
    qpdf \
    ghostscript
# qpdf: linearizes (web-optimises) uploaded PDFs so the reader opens page 1 from
# the first bytes over an HTTP range request instead of downloading the whole file.
# ghostscript: optionally re-compresses an uploaded PDF (150-dpi /ebook preset)
# when the teacher picks "compressed" at upload — smaller file, quality unchanged
# for reading. See compressPdf in controllers/materialController.js.

# LibreOffice (headless) converts uploaded Word/PowerPoint study materials to
# PDF so they can be shown in the in-app viewer. Only the Writer/Impress/Calc
# filters are installed to keep the image as small as this can reasonably be.
# If this ever fails to install, the Materials feature still works for PDFs and
# images — the upload just tells the teacher to convert to PDF first.
RUN apk add --no-cache \
    libreoffice-writer \
    libreoffice-impress \
    libreoffice-calc \
    ttf-dejavu \
    ttf-liberation
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    # CR-111: the whatsapp-web.js integration ships DISABLED by default (it pulls the
    # archiver advisory chain and needs a real WhatsApp session). Set explicitly to
    # "true" only on a host that actually uses it.
    WHATSAPP_WEB_ENABLED=false

# Install production dependencies first for better layer caching. CR-110: `npm ci`
# installs EXACTLY the committed lockfile (and fails if package.json and the lock
# drift), so the image is REPRODUCIBLE — no non-deterministic `npm install` fallback.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy the rest of the source
COPY . .

# The app reads PORT from env (defaults to 5000)
EXPOSE 5000

CMD ["node", "server.js"]
