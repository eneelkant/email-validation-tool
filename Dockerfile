# MailSure MCP / mailsure-api — multi-stage production image
# OPENVERIFY_* env names kept for compatibility with .env / Compose / Render.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY data ./data
RUN npm rebuild better-sqlite3 && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    OPENVERIFY_TRANSPORT=http \
    OPENVERIFY_HTTP_HOST=0.0.0.0 \
    OPENVERIFY_HTTP_PORT=8787 \
    OPENVERIFY_DATA_DIR=/data \
    OPENVERIFY_DB_PATH=/data/openverify.sqlite \
    OPENVERIFY_UPLOAD_DIR=/data/uploads \
    OPENVERIFY_OUTPUT_DIR=/data/output \
    OPENVERIFY_DISPOSABLE_PATH=/app/data/disposable-domains.txt
RUN useradd --system --uid 10001 --create-home openverify \
  && mkdir -p /data/uploads /data/output \
  && chown -R openverify:openverify /data
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/data ./data
USER openverify
EXPOSE 8787
# Prefer PLATFORM PORT (Render) when set; fall back to OPENVERIFY_HTTP_PORT / 8787.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||process.env.OPENVERIFY_HTTP_PORT||'8787';fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js", "--transport", "http"]
