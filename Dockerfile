FROM node:20-slim

# Chromium del sistema (puppeteer no descarga el suyo) + fuentes para render.
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Primero las dependencias (capa cacheable) con los parches (patch-package corre en postinstall).
COPY package.json package-lock.json* ./
COPY patches ./patches
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
