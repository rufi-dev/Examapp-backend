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
    tzdata
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
