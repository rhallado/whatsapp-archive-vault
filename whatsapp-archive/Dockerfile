# ---------- build ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime

# Chromium e fontes necessárias para whatsapp-web.js / puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    dumb-init \
    tini \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force

COPY --from=build /app/dist ./dist

# Diretórios persistentes (montados como volumes pelo compose)
RUN mkdir -p /data/sessions /data/exports /data/tmp \
  && chown -R node:node /app /data

USER node

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server.js"]
