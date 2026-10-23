# Disposable validation image, never a deployed service. No cloud credentials.
FROM node:22.23.4-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/colearnx-v1.0
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY apps/api/package.json apps/api/package-lock.json ./apps/api/
RUN npm --prefix apps/api ci --include=dev --no-audit --no-fund
COPY apps/video-worker/package.json apps/video-worker/package-lock.json ./apps/video-worker/
RUN npm --prefix apps/video-worker ci --include=dev --no-audit --no-fund
COPY . .
CMD ["npm", "run", "api:test"]
