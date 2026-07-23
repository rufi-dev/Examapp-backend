# Backend (Express) image for Hetzner
FROM node:18-alpine

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
    poppler-utils
# qpdf: linearizes (web-optimises) uploaded PDFs so the reader opens page 1 from
# the first bytes over an HTTP range request instead of downloading the whole file.
# poppler-utils: pdftoppm renders individual PDF pages to JPEG and pdfinfo counts
# pages — large scanned banks are shown as server-rendered page images (opens in
# ~1s) instead of streaming the whole file through pdf.js (dozens of serial range
# requests = 15s+). See renderPage in controllers/materialController.js.

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
    WHATSAPP_WEB_ENABLED=true

# Install production dependencies first for better layer caching.
# Uses `npm install` (not `npm ci`) because the committed lock file is not in
# perfect sync with package.json; install reconciles it.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy the rest of the source
COPY . .

# The app reads PORT from env (defaults to 5000)
EXPOSE 5000

CMD ["node", "server.js"]
