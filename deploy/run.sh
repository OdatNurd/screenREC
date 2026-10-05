#!/bin/bash
# Launch the Screen Recorder container.
#
# Builds the image from this repo and runs it in the standard layout:
# host :8901 -> container nginx :80 -> Next.js :3000 + Express :3001 (Basic Auth).
#
# Usage: ./run.sh [api-password]
#   The password can also be provided via the API_PASSWORD environment variable.
#   Omitting it FAILS CLOSED: /api rejects every request until a password is set.

IMAGE="screenrec"
CONTAINER_NAME="screenrec-app"
PORT=8901
PUBLIC_URL="https://recorder.thedragonland.net"
API_USER="api"
API_PASSWORD="${1:-${API_PASSWORD:-}}"

echo "Building $IMAGE..."
docker build -t "$IMAGE" . || exit 1

if [ -z "$API_PASSWORD" ]; then
    echo "WARNING: no API password given - /api will reject ALL requests (fail closed)."
    echo "         re-run as: ./run.sh '<api-password>'"
fi

echo "Stopping and removing existing container..."
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

echo "Launching Screen Recorder on port $PORT..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --security-opt seccomp=unconfined \
  -p "$PORT:80" \
  -e API_USER="$API_USER" \
  -e API_PASSWORD="$API_PASSWORD" \
  --health-cmd="curl -fsS http://localhost:3001/health || exit 1" \
  --health-interval=30s \
  --health-timeout=10s \
  --health-retries=3 \
  --restart unless-stopped \
  "$IMAGE"

echo "Done. Access Screen Recorder at $PUBLIC_URL"
