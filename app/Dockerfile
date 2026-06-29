# BMW Trust Bundle for the corporate proxy's TLS interception.
# Fetched at build time so the runtime image is self-contained.
# The URL is internal and only reachable from the BMW network — outside
# BMW this stage is skipped (the image still builds; outbound TLS will
# fall back to the system CAs).
FROM node:24-slim AS ca
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /tmp/bmw-trust-bundle.pem \
      https://trustbundle.bmwgroup.net/BMW_Trusted_Certificates_Latest.pem \
    || (echo "(non-BMW build: BMW trust bundle skipped)" && : > /tmp/bmw-trust-bundle.pem) \
 && test -e /tmp/bmw-trust-bundle.pem

# build stage: install + build frontend
FROM node:24-slim AS build
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

# run stage: prod deps + server + built dist
FROM node:24-slim AS run
WORKDIR /app
ENV NODE_ENV=production
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev
# Install the `claude` CLI globally so LLM_PROVIDER=cli works inside the
# container. The CLI reads ~/.claude/.credentials.json — which run.sh
# bind-mounts to /home/app/.claude — to authenticate with the user's
# Pro/Max subscription. Without this, the CLI provider errors with
# "Not logged in" on first request.
RUN npm install -g @anthropic-ai/claude-code
COPY app/server ./server
COPY --from=build /app/dist ./dist
COPY --from=ca /tmp/bmw-trust-bundle.pem /etc/ssl/certs/bmw-trust-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/bmw-trust-bundle.pem
ENV PORT=8787 DATA_DIR=/data DB_DIR=/db
EXPOSE 8787
CMD ["node", "server/index.mjs"]
