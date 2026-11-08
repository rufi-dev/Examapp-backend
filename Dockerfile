# Backend (Express) image for Hetzner
# Node 24: the Claude Code CLI needs Node >= 22 (and 18 is end-of-life).
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

# AI on the owner's subscriptions (helper/cliAi.js): the Claude Code and Codex
# CLIs, pinned to the versions Examopia runs in production. Their logins live
# in the cli_claude / cli_codex volumes (or CLAUDE_CODE_OAUTH_TOKEN in .env),
# never in the image.
RUN npm install --global --no-audit --no-fund @anthropic-ai/claude-code@2.1.317 @openai/codex@0.167.0-alpha.4

# poppler-utils: Claude's Read tool draws PDF pages with `pdftoppm` (without it
# every PDF reads as "unreadable"). ghostscript: Codex can only see a PDF as
# attached page images, which are drawn with `gs`. Own layer, after the CLIs.
RUN apk add --no-cache poppler-utils ghostscript

# Copy the rest of the source
COPY . .

# The app reads PORT from env (defaults to 5000)
EXPOSE 5000

CMD ["node", "server.js"]
