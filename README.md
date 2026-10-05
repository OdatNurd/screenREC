# Screen Recorder

A simple, privacy-first web screen recorder, stripped down for self-hosting: the recorder **is** the home page, permanently dark, with hardware selection, audio metering, output resolution control, and password-protected MP4 conversion.

This is a trimmed fork of **[screenREC](https://github.com/heysagnik/screenREC)** by [Sagnik Sahoo](https://twitter.com/heysagnik) — the original project does the hard work; this fork removes the marketing surface and packages everything into one Docker container for personal deployment. All credit for the original design and implementation goes upstream.

## Features

- **Screen / window / tab recording** — capture runs entirely client-side
- **Camera overlay** — PiP or circle layout, draggable position
- **Hardware selection** — explicit camera and microphone dropdowns (not just browser defaults)
- **Audio level meter** — live VU meter to confirm the selected mic is hot before recording
- **Output resolution control** — `Match source / 1440p / 1080p / 720p / 480p`; sources are uniformly scaled to fill the chosen size (aspect preserved, zoom to fill, bars only when aspect differs). Active source dimensions are displayed
- **Native background effects** — background blur and green screen via the OS-level Background Blur / Background Segmentation Mask APIs (no wasm, no ML in the page; where supported)
- **MP4 export** — WebM is instant and client-side; MP4 conversion runs through the server's FFmpeg and is protected with HTTP Basic Auth so the CPU can't be abused
- **Disk-backed recordings** — recorded chunks are spooled to the browser's private temp file system (OPFS) as they arrive, so RAM stays flat even for very long recordings; falls back to memory where OPFS is unavailable
- **Camera mirror toggle** — mirror the live preview (self-view); the recorded output is never mirrored
- **Permanent dark mode** — hardcoded, no retina-burn

## Local development (no Docker)

```bash
pnpm install
pnpm dev          # web on :3000, api on :3001
```

- `pnpm dev:web` / `pnpm dev:api` run the apps individually; `pnpm build && pnpm start` also works.
- The frontend calls same-origin `/api`; Next.js proxies it to the local API
  (`API_PROXY_TARGET`, default `http://127.0.0.1:3001`) when nginx isn't in front,
  so MP4 conversion works locally too.
- Locally the API is unauthenticated (no nginx in the path); leave the transcode
  password blank in the download dialog.
- Copy [`.env.template`](.env.template) and adjust if needed (its defaults fit local dev).

## Deployment (Docker + Apache)

One container bundles **nginx + Next.js + Express + FFmpeg** on `node:20-bullseye` (chosen for older kernel/glibc hosts). nginx routes `/` to the frontend and `/api/` to the convert API, which it guards with Basic Auth. Your Apache vhost in front terminates TLS and enforces the same Basic Auth a second time.

```
Browser ──https──▶ Apache (recorder.thedragonland.net:443)
                       │ ProxyPass → http://localhost:8901
                       ▼
              container nginx :80 ── /     → Next.js :3000
                                      └─ /api → Express :3001 (Basic Auth, FFmpeg)
```

### 1. Launch the container

[`deploy/run.sh`](deploy/run.sh) builds the image from this repo and starts the container in the layout above (host port **8901**):

```bash
./deploy/run.sh 'your-strong-password'
```

Equivalent commands without the script:

```bash
docker build -t screenrec .

docker run -d --name screenrec-app \
  --security-opt seccomp=unconfined \
  -p 8901:80 \
  -e API_USER=api \
  -e API_PASSWORD='your-strong-password' \
  --health-cmd="curl -fsS http://localhost:3001/health || exit 1" \
  --health-interval=30s --health-timeout=10s --health-retries=3 \
  --restart unless-stopped \
  screenrec
```

- If `API_PASSWORD` is unset, the container **fails closed**: every `/api` request returns 401, so FFmpeg is never reachable unauthenticated.
- `API_HTPASSWD_FILE=/path/to/htpasswd` (mount the file) overrides generated credentials.
- Health check: `GET :3001/health` (checked internally by Docker).

### 2. Create the API credential (Apache side)

The download dialog's password field is sent as `Authorization: Basic user:password`, where the user is `NEXT_PUBLIC_API_USER` (default `api`). Create the **same** user and password in Apache's htpasswd:

```bash
htpasswd -c /etc/apache2/htpasswd-screenrec api
```

Keep this in sync with `API_USER`/`API_PASSWORD` from step 1 — the UI's single password field has to satisfy both auth layers.

### 3. Apache vhost

Standard reverse-proxy vhost plus Basic Auth on `/api` (needs `mod_proxy`, `mod_proxy_http`, `mod_headers`, `mod_auth_basic`):

```apache
<VirtualHost *:443>
    ServerName recorder.thedragonland.net

    ProxyRequests Off
    ProxyPreserveHost On

    RequestHeader set X-Forwarded-For "%{REMOTE_ADDR}s"
    RequestHeader set X-Forwarded-Proto "https"

    ProxyPass "/" "http://localhost:8901/"
    ProxyPassReverse "/" "http://localhost:8901/"

    # Protect the API at the vhost level too (same credentials as the container)
    <Location /api>
        AuthType Basic
        AuthName "Screen Recorder API"
        AuthUserFile /etc/apache2/htpasswd-screenrec
        Require valid-user
    </Location>
</VirtualHost>
```

Basic Auth is enforced **twice** on purpose: at your Apache vhost and inside the container's nginx (which fails closed without `API_PASSWORD`). The container layer guarantees FFmpeg is never reachable unauthenticated regardless of the proxy setup.

### 4. Environment variables

Everything has working defaults for the layout above; [`.env.template`](.env.template) is the canonical copy of this table.

| Variable | Default | Read | What it does |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | *(empty — same-origin)* | build | Base URL the browser calls for MP4 conversion. Leave empty: the browser calls same-origin `/api`, which the proxy routes onward. |
| `NEXT_PUBLIC_API_USER` | `api` | build (`docker build --build-arg NEXT_PUBLIC_API_USER=…`) | Username the UI pairs with its password field. Must match the htpasswd user in **both** layers. |
| `API_PROXY_TARGET` | `http://127.0.0.1:3001` | build/start | Where Next.js proxies `/api` when nginx isn't in front (local dev / bare `next start`). Unused in the container. |
| `PORT` | `3001` | run | Port the Express convert API listens on. |
| `FRONTEND_URL` | `http://localhost:3000` | run | Allowed CORS origin during local development. |
| `API_USER` | `api` | run | User the container's nginx Basic Auth is generated for. |
| `API_PASSWORD` | *(unset)* | run | Password for the container's nginx Basic Auth. **Unset = fail closed** (every `/api` request 401s). |
| `API_HTPASSWD_FILE` | *(unset)* | run | Path to a mounted htpasswd file; when present it overrides `API_USER`/`API_PASSWORD`. |

Mind the "Read" column: `NEXT_PUBLIC_*` values are **baked into the frontend at build time**. In the container that means `docker build --build-arg …`; for local dev, set them before `pnpm dev` / `pnpm build`.

### 5. Verify

```bash
curl -i https://recorder.thedragonland.net/api/health            # 401 without credentials — expected
curl -i -u api:your-strong-password \
     https://recorder.thedragonland.net/api/health               # 200
```

Then in the browser: record a short clip, play it back, download WebM, and export MP4 with the password. A wrong password must be rejected with the recording still available.

### How the MP4 password works

The download dialog has a password field (shown when MP4 is selected). The browser sends it as an `Authorization: Basic ...` header to `/api/convert`, where Apache and nginx validate it before FFmpeg ever runs.

Downloads go straight to the browser's download folder under the name shown in the Save Recording dialog (spaces and invalid filename characters become `_`).

Failure behavior is explicit:

- **Wrong password (401)** → clear "Wrong password" error and **no** automatic download; the recording stays available so you can retry.
- **Server/network failure** → WebM is downloaded as a fallback, with a notification stating exactly that.

## Browser support

| Browser | Status |
|---------|--------|
| Chrome / Edge | ✅ Supported |
| Firefox | ✅ Supported (no native background effects) |
| Safari | ✅ Supported (no native background effects) |
| Mobile | ❌ Not supported (`getDisplayMedia` limitation) |

### Native background effects — support notes

The blur/green-screen toggles are **feature-detected** and only appear when the platform exposes the native capability (`backgroundBlur` / `backgroundSegmentationMask` on the camera track):

- Chromium browsers on **Windows**: full toggle control.
- **macOS / ChromeOS**: blur is controlled by the OS (Control Center); the app observes and reflects state, the toggle may not be able to change it.
- Some Chrome versions require the `chrome://flags/#enable-experimental-web-platform-features` flag.
- No wasm/ML fallback by design — where the OS can't do it, the feature stays hidden.

## Project structure

```
├── apps/
│   ├── web/        # Next.js frontend (the recorder)
│   └── api/        # Express API (FFmpeg MP4 conversion)
├── packages/
│   └── shared/     # Shared types
├── deploy/
│   ├── nginx.conf      # Routes / -> web, /api -> api (Basic Auth)
│   └── entrypoint.sh   # Starts web + api + nginx in the container
├── Dockerfile      # Single-container build
└── .env.template   # Documented environment variables
```

## License

MIT — see [LICENSE.md](LICENSE.md).
