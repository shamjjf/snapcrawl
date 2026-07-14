# SnapCrawl API (apps/api). The API runs TypeScript directly via tsx, so there
# is no compile step — the image needs only workspace deps + source.
#
# EasyPanel: set the service's Build method to "Dockerfile". The admin panel
# (apps/web) and the Chrome extension are NOT part of this image; deploy the
# panel as its own service if needed.
FROM node:24-alpine

WORKDIR /app

# Dependency layer — cached until a manifest or the lockfile changes.
# Only the API + shared workspaces are installed (dev deps included: tsx).
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace apps/api --workspace packages/shared

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

ENV NODE_ENV=production
EXPOSE 4000

USER node
CMD ["node_modules/.bin/tsx", "apps/api/src/index.ts"]
