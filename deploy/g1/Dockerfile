# syntax=docker/dockerfile:1
# Build from the repository root with -f deploy/g1/Dockerfile so the adjacent
# Dockerfile.dockerignore filters the context. The only build inputs from the
# environment are the PUBLIC receipt key ID and raw Ed25519 public key.
FROM node:22-bookworm-slim AS base
RUN npm install --global npm@11.6.1 --no-audit --no-fund \
    && npm cache clean --force
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
COPY packages/job-send/package.json ./packages/job-send/package.json
COPY packages/job-send-ui/package.json ./packages/job-send-ui/package.json
COPY packages/job-send-app/package.json ./packages/job-send-app/package.json
# Keep optional build binaries (esbuild); development packages are pruned later.
RUN npm ci --include=dev --no-audit --no-fund
COPY packages/ ./packages/

# These values are published in the browser bundle. Never pass private keys,
# database credentials, or OAuth secrets as build arguments.
ARG RECEIPT_KEY_ID
ARG RECEIPT_PUBLIC_KEY_B64URL
RUN npm run build \
    && npm run --workspace=packages/job-send-ui build:app
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    OWNER_APP_DIR=/app/packages/job-send-ui/dist/owner-app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules

# Preserve workspace link targets. job-send remains external to the app bundle;
# its migration loader resolves this src/ directory relative to its dist/ files.
COPY --from=build /app/packages/job-send/package.json ./packages/job-send/package.json
COPY --from=build /app/packages/job-send/dist ./packages/job-send/dist
COPY --from=build /app/packages/job-send/src/executor/db/migrations ./packages/job-send/src/executor/db/migrations
COPY --from=build /app/packages/job-send-app/package.json ./packages/job-send-app/package.json
COPY --from=build /app/packages/job-send-app/dist ./packages/job-send-app/dist
COPY --from=build /app/packages/job-send-ui/package.json ./packages/job-send-ui/package.json
COPY --from=build /app/packages/job-send-ui/dist/owner-app ./packages/job-send-ui/dist/owner-app

# Runtime secrets are supplied by Azure through environment variables.
USER node
EXPOSE 8080
CMD ["node", "packages/job-send-app/dist/main.mjs"]
