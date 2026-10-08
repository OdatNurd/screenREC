#!/bin/bash
# Launch the Screen Recorder container.
#
# Builds the image from this repo and runs it in the standard layout:
# host :8901 -> container nginx :80 -> Next.js :3000 + Express :3001 (Basic Auth).
#
# Configuration (including API_USER and API_PASSWORD) is pulled from the .env file.
# Usage: ./deploy/run.sh

IMAGE="screenrec"
CONTAINER_NAME="screenrec-app"
PORT=8901
PUBLIC_URL="https://recorder.thedragonland.net"

# Ensure .env exists before attempting to build or run
if [ ! -f ".env" ]; then
    echo "ERROR: .env file not found in the repository root."
    echo "Copy .env.template to .env and configure your API_PASSWORD."
    exit 1
fi

# Commit stamped into the UI footer ("screenREC · build <sha>").
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
echo "Building $IMAGE (commit $GIT_SHA)..."
docker build --build-arg GIT_SHA="$GIT_SHA" -t "$IMAGE" . || exit 1

echo "Stopping and removing existing container..."
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

echo "Launching Screen Recorder on port $PORT..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --security-opt seccomp=unconfined \
  -p "$PORT:80" \
  --env-file .env \
  --health-cmd="curl -fsS http://localhost:3001/health || exit 1" \
  --health-interval=30s \
  --health-timeout=10s \
  --health-retries=3 \
  --restart unless-stopped \
  "$IMAGE"

echo "Done. Access Screen Recorder at $PUBLIC_URL"
