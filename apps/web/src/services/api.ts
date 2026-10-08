// API base URL. Empty string = same-origin (behind the container's nginx).
// Local development defaults to the dev API port.
const rawApiUrl =
    process.env.NEXT_PUBLIC_API_URL ??
    (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3001');
const API_URL = rawApiUrl.startsWith('http')
    ? rawApiUrl
    : rawApiUrl
        ? `https://${rawApiUrl}`
        : '';

/** Basic Auth username sent to the convert endpoint (must match the server's htpasswd). */
export const API_USER = process.env.NEXT_PUBLIC_API_USER || 'api';

export interface ConvertOptions {
    /** Real, measured upload progress: 0-100 of the request body. */
    onProgress?: (progress: number) => void;
    /**
     * Phase switch: 'uploading' (measured via onProgress) → 'converting'
     * (server-side work, which is not measurable from the browser).
     */
    onPhase?: (phase: 'uploading' | 'converting') => void;
    /** Password paired with API_USER for HTTP Basic Auth. */
    password?: string;
}

export class ApiAuthError extends Error {
    constructor() {
        super('Unauthorized: wrong password');
        this.name = 'ApiAuthError';
    }
}

export class ApiUnreachableError extends Error {
    constructor(reason: string) {
        super(`Convert service unreachable: ${reason}`);
        this.name = 'ApiUnreachableError';
    }
}

function basicAuthHeader(user: string, password: string): string {
    return `Basic ${btoa(`${user}:${password}`)}`;
}

/**
 * Convert video blob to MP4 using the backend API.
 * Sends the Basic Auth credentials typed into the UI (validated by the reverse
 * proxies). Uses XHR so upload progress is real (fetch has none): onProgress
 * reports measured upload bytes (0-100); once the body is fully uploaded the
 * server converts unmeasured — signalled via onPhase('converting') so the UI
 * never fakes progress for that stretch.
 */
export async function convertToMp4(
    videoBlob: Blob,
    options?: ConvertOptions
): Promise<Blob> {
    const formData = new FormData();
    formData.append('video', videoBlob, 'recording.webm');

    options?.onPhase?.('uploading');
    options?.onProgress?.(0);

    return new Promise<Blob>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_URL}/api/convert`);
        if (options?.password) {
            xhr.setRequestHeader('Authorization', basicAuthHeader(API_USER, options.password));
        }
        xhr.responseType = 'blob';
        // The server-side ffmpeg run is capped at 8 minutes and nginx waits up
        // to 600s; the client gives up last (12 min) and fails loudly instead
        // of hanging forever.
        xhr.timeout = 12 * 60 * 1000;

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                options?.onProgress?.(Math.round((e.loaded / e.total) * 100));
            }
        };
        xhr.upload.onload = () => {
            // Whole body received; the server-side conversion is unmeasured.
            options?.onPhase?.('converting');
        };

        xhr.onload = () => {
            if (xhr.status === 401) {
                reject(new ApiAuthError());
                return;
            }
            if (xhr.status === 404) {
                // The convert endpoint is not reachable at all (e.g. no API
                // behind the same origin) - distinct from a failed conversion.
                reject(new ApiUnreachableError('endpoint not found (404)'));
                return;
            }
            if (xhr.status < 200 || xhr.status >= 300) {
                let message = `Conversion failed (HTTP ${xhr.status})`;
                try {
                    const body = JSON.parse(xhr.responseText) as { message?: string };
                    if (body.message) message = body.message;
                } catch { /* keep generic message */ }
                reject(new Error(message));
                return;
            }
            options?.onProgress?.(100);
            resolve(xhr.response);
        };

        xhr.onerror = () => reject(new ApiUnreachableError('network error'));
        xhr.ontimeout = () => reject(new ApiUnreachableError('timed out after 12 minutes'));

        xhr.send(formData);
    });
}

/**
 * Check if the API is available (without credentials — expect 401 when the
 * endpoint is protected, which still proves reachability).
 */
export async function checkApiHealth(): Promise<boolean> {
    try {
        const response = await fetch(`${API_URL}/api/health`);
        return response.ok || response.status === 401;
    } catch {
        return false;
    }
}
