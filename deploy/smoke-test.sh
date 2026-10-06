#!/bin/bash
# Non-destructive Docker build + deploy smoke test for the screenREC
# single-container deployment (Dockerfile + deploy/entrypoint.sh + nginx).
#
# Verifies, on any host with a Docker daemon:
#   1. the image builds from the current checkout (local sources, incl. any
#      uncommitted work),
#   2. the container comes up healthy (web :3000 + api :3001 + nginx :80),
#   3. nginx Basic Auth topology: / is public, /api/ fails closed without or
#      with wrong credentials, and accepts the configured password,
#   4. a spaced password survives end to end (the quoted-.env / htpasswd bug),
#   5. /api/convert turns a tiny WebM into a valid MP4 through the auth layer.
#
# It deliberately uses its own image tag, container name, and host port, so it
# never stops or replaces a running production container (deploy/run.sh's
# screenrec-app on :8901 is untouched).
#
# Usage:   ./deploy/smoke-test.sh [--keep]
#   --keep   leave the smoke container running (for the manual browser check)
#
# Exit 0 = all checks passed; non-zero = first failing check's name is printed.

set -u -o pipefail

IMAGE="screenrec-smoke:dev"
NAME="screenrec-smoke"
PORT="${SMOKE_PORT:-8902}"
API_USER="api"
# Spaces on purpose: exercises the password-quoting bug class found in deploy.
API_PASSWORD="smoke test pw with spaces"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

PASS=0
FAIL=0
step() { printf '\n== %s\n' "$1"; }
ok()   { PASS=$((PASS + 1)); printf '   ok: %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '   FAIL: %s\n' "$1"; }
die()  { bad "$1"; summary; docker logs "$NAME" 2>&1 | tail -25; cleanup; exit 1; }
cleanup() {
    [ "$KEEP" = 1 ] && { echo "keeping container $NAME on :$PORT"; return; }
    docker rm -f "$NAME" >/dev/null 2>&1 || true
}
summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; }

command -v docker >/dev/null 2>&1 || { echo "FAIL: docker CLI not found on this host"; exit 1; }
command -v curl   >/dev/null 2>&1 || { echo "FAIL: curl not found on this host"; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "FAIL: ffmpeg not found (needed to mint the test clip)"; exit 1; }

step "build image $IMAGE"
if docker build -t "$IMAGE" .; then ok "image built"; else die "docker build"; fi

step "run smoke container on :$PORT (production container untouched)"
docker rm -f "$NAME" >/dev/null 2>&1 || true
if docker run -d \
    --name "$NAME" \
    --security-opt seccomp=unconfined \
    -p "$PORT:80" \
    -e API_USER="$API_USER" \
    -e API_PASSWORD="$API_PASSWORD" \
    "$IMAGE" >/dev/null; then ok "container started"; else die "docker run"; fi

step "readiness (nginx :80 -> web :3000 + api :3001)"
BASE="http://localhost:$PORT"
ready=0
for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/" 2>/dev/null)
    [ "$code" = "200" ] && { ready=1; break; }
    sleep 2
done
[ "$ready" = 1 ] || die "frontend never answered 200 on $BASE/"
ok "frontend up"

step "frontend serves the app (public, no auth)"
curl -s --max-time 10 "$BASE/" | grep -q "Screen Recorder" \
    && ok "page contains the app shell" \
    || die "app shell missing"

step "Basic Auth topology"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/api/health")
[ "$code" = "401" ] && ok "/api/health without credentials -> 401 (fail closed)" || die "expected 401 unauthenticated, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -u "$API_USER:wrong-password" "$BASE/api/health")
[ "$code" = "401" ] && ok "wrong password -> 401" || die "expected 401 with wrong password, got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -u "$API_USER:$API_PASSWORD" "$BASE/api/health")
[ "$code" = "200" ] && ok "correct spaced password -> 200 (htpasswd quoting survives)" || die "expected 200 with correct password, got $code"

step "/api/convert through the auth layer"
CLIP=$(mktemp /tmp/screenrec-smoke-XXXX.webm)
ffmpeg -v error -f lavfi -i testsrc=size=320x240:rate=15 -f lavfi -i sine=frequency=440 -t 2 -c:v libvpx -b:v 200k -c:a libopus "$CLIP" -y \
    || die "could not mint test clip"
code=$(curl -s -o /tmp/screenrec-smoke-out.mp4 -w '%{http_code}' --max-time 300 \
    -u "$API_USER:$API_PASSWORD" -F "video=@$CLIP;type=video/webm" "$BASE/api/convert")
[ "$code" = "200" ] && ok "convert -> HTTP 200" || die "convert returned $code"
ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/screenrec-smoke-out.mp4 >/dev/null 2>&1 \
    && ok "converted MP4 is a valid media file" || die "converted MP4 fails to probe"
ffmpeg -v error -i /tmp/screenrec-smoke-out.mp4 -f null - && ok "converted MP4 decodes clean"
rm -f "$CLIP"

step "edit feature (client-side: verify in the browser)"
echo "   the edit engine runs in the browser; open $BASE and check:"
echo "     - record a short clip (or use an existing one)"
echo "     - Edit -> trim/cut/title card -> timeline stays inside its box"
echo "     - playback skips cuts and holds on the title card"
echo "     - Download -> Edited (WebM) plays with continuous audio"

summary
cleanup
[ "$FAIL" = 0 ]
