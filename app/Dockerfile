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
COPY app/server ./server
COPY --from=build /app/dist ./dist
ENV PORT=8787 DATA_DIR=/data DB_DIR=/db
EXPOSE 8787
CMD ["node", "server/index.mjs"]
