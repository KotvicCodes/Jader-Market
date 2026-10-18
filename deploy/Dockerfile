FROM node:22.22.1-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global npm@11.21.0
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=cache,target=/app/.cache/npm npm ci --fetch-timeout=60000 --fetch-retries=2

FROM dependencies AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build

FROM node:22.22.1-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /var/lib/jader-worker && chown node:node /var/lib/jader-worker
USER node
EXPOSE 3000
CMD ["node", "scripts/run.mjs", "next", "start", "--hostname", "0.0.0.0"]
