#!/bin/bash
# Container entrypoint: starts the Next.js web server, the Express API,
# and nginx (which fronts both and protects /api with Basic Auth).
set -e

echo "[entrypoint] preparing nginx htpasswd..."

if [ -n "${API_HTPASSWD_FILE:-}" ] && [ -f "$API_HTPASSWD_FILE" ]; then
    # Mounted htpasswd file wins over generated credentials
    cp "$API_HTPASSWD_FILE" /etc/nginx/.htpasswd
    echo "[entrypoint] using mounted htpasswd file: $API_HTPASSWD_FILE"
elif [ -n "${API_PASSWORD:-}" ]; then
    API_USER="${API_USER:-api}"
    htpasswd -Bbc /etc/nginx/.htpasswd "$API_USER" "$API_PASSWORD"
    echo "[entrypoint] generated htpasswd for user '$API_USER'"
else
    # Fail closed: an empty htpasswd rejects every request to /api.
    # FFmpeg must never be reachable unauthenticated.
    : > /etc/nginx/.htpasswd
    echo "[entrypoint] WARNING: API_PASSWORD not set - /api will reject ALL requests (401)."
fi

echo "[entrypoint] starting web server (port 3000)..."
node /app/web/apps/web/server.js &
WEB_PID=$!

echo "[entrypoint] starting api server (port 3001)..."
node /app/api/dist/index.js &
API_PID=$!

echo "[entrypoint] starting nginx (port 80)..."
nginx -g 'daemon off;' &
NGINX_PID=$!

shutdown() {
    echo "[entrypoint] shutting down..."
    kill "$WEB_PID" "$API_PID" "$NGINX_PID" 2>/dev/null || true
    wait
    exit 0
}
trap shutdown TERM INT

# If any process dies, shut the container down so the orchestrator restarts it
wait -n "$WEB_PID" "$API_PID" "$NGINX_PID"
echo "[entrypoint] a service exited unexpectedly - stopping container"
shutdown
