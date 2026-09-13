# Multi-stage build: build the Vite client, then serve it + the API from a slim
# Node runtime. A single process serves both /api/* and the static frontend.

# ---- build stage ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:22-slim AS runtime
WORKDIR /app

# Install only production deps (no dev tooling in the image).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# The server (server/, src/domain/, src/engine/, src/data/, scripts/) + built client.
COPY server/ ./server/
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY --from=build /app/dist/ ./dist/

# Non-root user for security.
USER node

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/start-server.mjs"]
