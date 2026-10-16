# Multi-stage build for Cloud Run / any container platform.
# Secrets are NEVER baked into the image — inject them at deploy time.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Gate the artefact on the real checks, not just a compile.
RUN npm run lint && npm test && NODE_ENV=production npm run build
RUN cp -r .next/static .next/standalone/.next/static

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0
ENV NODE_OPTIONS="--max-old-space-size=384"

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/package.json ./package.json

USER node
EXPOSE 8080
CMD ["node", "server.js"]
