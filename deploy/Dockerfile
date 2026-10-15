# One image runs both backend processes (see docker-compose.yml). Build from the repo root:
#   docker build -f deploy/Dockerfile -t telestream-backend .
FROM node:22-slim
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/server/package.json apps/server/
COPY apps/telegram-service/package.json apps/telegram-service/
COPY tests/package.json tests/
# No lockfile ships with this archive: the first `npm install` creates package-lock.json. Commit it for reproducible builds.
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/server apps/server
COPY apps/telegram-service apps/telegram-service
COPY migrations migrations
ENV NODE_ENV=production NODE_NO_WARNINGS=1
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
