# Optional CA bundle stage.
#
# If your network does TLS interception (corporate proxies, on-prem
# gateways, captive networks), set the build arg EXTRA_CA_BUNDLE_URL to
# the URL of a PEM bundle and the image will pick it up at runtime via
# NODE_EXTRA_CA_CERTS. The arg is optional and only useful for that
# setup. The default empty value produces an empty bundle file and
# behaves exactly like an image without this stage.
#
# Example:
#   docker build \
#     --build-arg EXTRA_CA_BUNDLE_URL=https://your-internal-host/ca.pem \
#     ...
FROM node:24-slim AS ca
ARG EXTRA_CA_BUNDLE_URL=""
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && if [ -n "$EXTRA_CA_BUNDLE_URL" ]; then \
        curl -fsSL -o /tmp/extra-ca-bundle.pem "$EXTRA_CA_BUNDLE_URL"; \
    else \
        : > /tmp/extra-ca-bundle.pem; \
    fi \
 && test -e /tmp/extra-ca-bundle.pem

# build stage: install + build frontend.
# Build doesn't need better-sqlite3 (server-only dep). Skipping postinstall
# scripts avoids pulling python3/build-essential just for `vite build`.
FROM node:24-slim AS build
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --ignore-scripts
COPY app/ ./
RUN npm run build

# run stage: prod deps + server + built dist
FROM node:24-slim AS run
WORKDIR /app
ENV NODE_ENV=production
COPY app/package.json app/package-lock.json ./
# better-sqlite3 11.x has no prebuilds for node 24 yet — install build
# tools, compile from source, then strip the tools so the runtime image
# stays slim. python3 / make / g++ together are ~150 MB; removing them
# at the end takes us back to ~250 MB.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
COPY app/server ./server
COPY --from=build /app/dist ./dist
COPY --from=ca /tmp/extra-ca-bundle.pem /etc/ssl/certs/extra-ca-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/extra-ca-bundle.pem
ENV PORT=8787 DATA_DIR=/data DB_DIR=/db
EXPOSE 8787
CMD ["node", "server/index.mjs"]
