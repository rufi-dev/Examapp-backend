# Backend (Express) image for Hetzner
FROM node:18-alpine

WORKDIR /app

# Install production dependencies first for better layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the source
COPY . .

# The app reads PORT from env (defaults to 5000)
EXPOSE 5000

CMD ["node", "server.js"]
