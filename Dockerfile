# Single-container deployment: Next.js frontend + Express API + FFmpeg + nginx.
#
# Base is node:20-bullseye on purpose: the destination host runs an older
# kernel/glibc and newer images can crash in clone3/seccomp. Debian bullseye's
# glibc 2.31 avoids that, and apt provides both ffmpeg and nginx.
#
# Build:  docker build -t screenrec .
# Run:    docker run -d -p 8080:80 -e API_USER=api -e API_PASSWORD=secret screenrec

# =============================================
# Build stage
# =============================================
FROM node:20-bullseye AS builder

RUN npm install -g pnpm@9.15.1

WORKDIR /app

# Copy the whole workspace (the build copies local sources rather than cloning
# a git repo, so local changes are included)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile

# Basic Auth username the UI pairs with its password field. Baked into the
# frontend at build time; override with: docker build --build-arg NEXT_PUBLIC_API_USER=...
ARG NEXT_PUBLIC_API_USER=api
ENV NEXT_PUBLIC_API_USER=$NEXT_PUBLIC_API_USER

# Builds apps/web (Next standalone output) and apps/api (tsc -> dist)
RUN pnpm build

# =============================================
# Production stage
# =============================================
FROM node:20-bullseye AS production

# Redirect apt to the Debian Archives to bypass 404s on EOL Bullseye
RUN echo "deb http://archive.debian.org/debian bullseye main" > /etc/apt/sources.list \
    && echo "deb http://archive.debian.org/debian-security bullseye-security main" >> /etc/apt/sources.list \
    && apt-get update -o Acquire::Check-Valid-Until=false \
    && apt-get install -y --no-install-recommends ffmpeg nginx curl apache2-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Next.js standalone server (self-contained node_modules)
COPY --from=builder /app/apps/web/.next/standalone ./web
COPY --from=builder /app/apps/web/.next/static ./web/apps/web/.next/static
COPY --from=builder /app/apps/web/public ./web/apps/web/public

# Express API: compiled output + runtime-only dependencies
COPY --from=builder /app/apps/api/dist ./api/dist
WORKDIR /app/api
RUN npm init -y \
    && npm install --save \
        cors@^2.8.5 \
        express@^4.21.2 \
        express-rate-limit@^8.2.1 \
        multer@^1.4.5-lts.1 \
        sanitize-filename@^1.6.3

# nginx config and entrypoint
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && mkdir -p /tmp/screenrec \
    && touch /etc/nginx/.htpasswd

# Web (Next) 3000, API (Express) 3001, nginx 80
ENV PORT=3001 \
    NODE_ENV=production
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
    CMD curl -fsS http://127.0.0.1:3001/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
