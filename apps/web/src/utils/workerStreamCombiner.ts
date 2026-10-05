/**
 * Stream Combiner
 * Combines screen/camera/audio into a single recordable stream.
 *
 * - Single source + "match source" resolution = direct passthrough (no canvas overhead).
 * - Fixed resolution presets (or green screen, or screen+camera) route through a
 *   canvas whose size is the preset, so the recorded output size is controlled.
 * - Sources are scaled to fit the canvas uniformly (scale = min(cw/sw, ch/sh)):
 *   small sources are zoomed up to fill, letterbox bars appear only when the
 *   source aspect ratio differs from the canvas.
 */

import { RecordingLayout } from '@/types/layout';
import { RECORDING_CONFIG } from '@/config/recording';

export interface GreenScreenOptions {
    enabled: boolean;
    color: string;
}

export interface WorkerCombinerOptions {
    screenStream: MediaStream | null;
    cameraStream: MediaStream | null;
    audioStream: MediaStream | null;
    cameraPosition: { x: number; y: number };
    cameraPositionKey?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    layout: RecordingLayout;
    /** Canvas size for the recording. null/undefined = match source. */
    targetResolution?: { width: number; height: number } | null;
    greenScreen?: GreenScreenOptions;
}

export interface WorkerCombinerResult {
    stream: MediaStream;
    cleanup: () => void;
    updateCameraPosition: (position: { x: number; y: number }) => void;
    updateLayout: (layout: RecordingLayout) => void;
}

/**
 * The platform background-segmentation mask marks the BACKGROUND region
 * (per the Background Segmentation Mask API naming). Set to false if a
 * platform delivers a person mask instead.
 */
const MASK_INDICATES_BACKGROUND = true;

// Store active cleanup functions so recordings can be force-released
const activeCleanups = new Set<() => void>();

/**
 * Force cleanup of any active combined-stream resources.
 * Call when stopping recording to ensure all tracks are released.
 */
export function forceCleanupCombinedStreams(): void {
    for (const cleanup of [...activeCleanups]) {
        try { cleanup(); } catch { /* ignore */ }
    }
    activeCleanups.clear();
}

export async function createWorkerCombinedStream(
    options: WorkerCombinerOptions
): Promise<WorkerCombinerResult> {
    const { screenStream, cameraStream, audioStream } = options;
    const greenScreenOn = !!options.greenScreen?.enabled;
    const fixedResolution = !!options.targetResolution;

    // Direct passthrough for single-source recording at native size (no canvas overhead).
    // Green screen needs the canvas, and fixed presets must control output size.
    if (!greenScreenOn && !fixedResolution) {
        if (screenStream && !cameraStream) {
            return createDirectStream(screenStream, audioStream, 'screen');
        }
        if (cameraStream && !screenStream) {
            return createDirectStream(cameraStream, audioStream, 'camera');
        }
    }

    return createCanvasCombinedStream(options);
}

async function createDirectStream(
    videoStream: MediaStream,
    audioStream: MediaStream | null,
    type: 'screen' | 'camera'
): Promise<WorkerCombinerResult> {
    const resultStream = new MediaStream();
    const videoTrack = videoStream.getVideoTracks()[0];
    if (videoTrack) resultStream.addTrack(videoTrack);

    // Mix audio tracks
    const hasScreenAudio = type === 'screen' && videoStream.getAudioTracks().length > 0;
    const hasMicAudio = audioStream && audioStream.getAudioTracks().length > 0;

    if (hasScreenAudio || hasMicAudio) {
        try {
            const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            const audioCtx = new AudioCtx({ sampleRate: RECORDING_CONFIG.AUDIO.SAMPLE_RATE });
            const destination = audioCtx.createMediaStreamDestination();

            const addSource = (stream: MediaStream, gain: number) => {
                const tracks = stream.getAudioTracks();
                if (tracks.length === 0) return;
                const source = audioCtx.createMediaStreamSource(new MediaStream(tracks));
                const gainNode = audioCtx.createGain();
                gainNode.gain.value = gain;
                source.connect(gainNode).connect(destination);
            };

            if (hasScreenAudio) addSource(videoStream, RECORDING_CONFIG.AUDIO_MIXING.GAIN.SCREEN);
            if (hasMicAudio) addSource(audioStream!, RECORDING_CONFIG.AUDIO_MIXING.GAIN.MICROPHONE);

            const mixedTrack = destination.stream.getAudioTracks()[0];
            if (mixedTrack) resultStream.addTrack(mixedTrack);
        } catch {
            const fallback = videoStream.getAudioTracks()[0] || audioStream?.getAudioTracks()[0];
            if (fallback) resultStream.addTrack(fallback);
        }
    }

    const cleanup = () => {
        resultStream.getTracks().forEach(t => {
            if (t !== videoTrack) try { t.stop(); } catch { /* ignore */ }
        });
        activeCleanups.delete(cleanup);
    };
    activeCleanups.add(cleanup);

    return {
        stream: resultStream,
        cleanup,
        updateCameraPosition: () => { },
        updateLayout: () => { },
    };
}

/** Metadata extension carrying the OS segmentation mask (Background Segmentation Mask API). */
type MaskFrameMetadata = VideoFrameCallbackMetadata & {
    backgroundSegmentationMask?: ImageBitmap;
};

let tmpCanvas: HTMLCanvasElement | null = null;
function getTmpCanvas(width: number, height: number): HTMLCanvasElement {
    if (!tmpCanvas) tmpCanvas = document.createElement('canvas');
    if (tmpCanvas.width !== width) tmpCanvas.width = width;
    if (tmpCanvas.height !== height) tmpCanvas.height = height;
    return tmpCanvas;
}

async function createCanvasCombinedStream(
    options: WorkerCombinerOptions
): Promise<WorkerCombinerResult> {
    const { screenStream, cameraStream, audioStream, cameraPosition, layout } = options;
    const greenScreenOn = !!options.greenScreen?.enabled;
    const greenScreenColor = options.greenScreen?.color || '#00b140';

    // Main video: screen when present, otherwise camera (camera-only recording).
    const mainStream = screenStream ?? cameraStream;
    const overlayStream = screenStream && cameraStream ? cameraStream : null;

    const mainTrack = mainStream?.getVideoTracks()[0];
    const settings = mainTrack?.getSettings();
    const width = options.targetResolution?.width || settings?.width || 1920;
    const height = options.targetResolution?.height || settings?.height || 1080;
    const fps = Math.min(settings?.frameRate || 30, 60);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Failed to create canvas context');

    const screenVideo = document.createElement('video');
    const cameraVideo = document.createElement('video');
    [screenVideo, cameraVideo].forEach(v => {
        v.muted = true;
        v.autoplay = true;
        v.playsInline = true;
    });

    if (screenStream) {
        screenVideo.srcObject = screenStream;
        await screenVideo.play().catch(() => { });
    }
    if (cameraStream) {
        cameraVideo.srcObject = cameraStream;
        await cameraVideo.play().catch(() => { });
    }

    // Latest OS-provided background segmentation mask for the camera feed.
    let latestMask: ImageBitmap | null = null;
    let maskFrameHandle: number | null = null;
    const maskVideo = cameraVideo;
    const supportsFrameCallback = typeof maskVideo.requestVideoFrameCallback === 'function';
    if (greenScreenOn && cameraStream && supportsFrameCallback) {
        const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
            const mask = (metadata as MaskFrameMetadata).backgroundSegmentationMask;
            if (mask) {
                latestMask?.close();
                latestMask = mask;
            }
            maskFrameHandle = maskVideo.requestVideoFrameCallback(onFrame);
        };
        maskFrameHandle = maskVideo.requestVideoFrameCallback(onFrame);
    }

    const scaleFactor = width / 1920;
    const overlayWidth = Math.round(400 * scaleFactor);
    const overlayHeight = layout === 'circle' ? overlayWidth : Math.round(280 * scaleFactor);
    const guidePad = Math.round(40 * scaleFactor);

    let camX = cameraPosition.x, camY = cameraPosition.y;
    switch (options.cameraPositionKey) {
        case 'top-left': camX = guidePad; camY = guidePad; break;
        case 'top-right': camX = width - overlayWidth - guidePad; camY = guidePad; break;
        case 'bottom-left': camX = guidePad; camY = height - overlayHeight - guidePad; break;
        case 'bottom-right': camX = width - overlayWidth - guidePad; camY = height - overlayHeight - guidePad; break;
    }

    let frameInterval: number | null = null;
    let cleanedUp = false;

    const renderFrame = () => {
        if (cleanedUp || !ctx) return;
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const mainVideo = screenStream ? screenVideo : cameraVideo;
        const isMainCamera = !screenStream && !!cameraStream;

        if (mainVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            const sw = mainVideo.videoWidth || 1, sh = mainVideo.videoHeight || 1;
            // Uniform scale-to-fit: zooms small sources up to fill, bars only on aspect mismatch.
            const scale = Math.min(canvas.width / sw, canvas.height / sh);
            const dw = sw * scale, dh = sh * scale;
            const dx = (canvas.width - dw) / 2, dy = (canvas.height - dh) / 2;

            if (greenScreenOn && isMainCamera) {
                drawMainWithGreenScreen(ctx, mainVideo, latestMask, dx, dy, dw, dh, canvas.width, canvas.height, greenScreenColor);
            } else {
                ctx.drawImage(mainVideo, dx, dy, dw, dh);
            }
        }

        if (overlayStream && screenVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && cameraVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            if (greenScreenOn) {
                drawCameraOverlayGreen(ctx, cameraVideo, latestMask, camX, camY, overlayWidth, overlayHeight, layout, greenScreenColor);
            } else {
                drawCameraOverlay(ctx, cameraVideo, camX, camY, overlayWidth, overlayHeight, layout);
            }
        }
    };

    frameInterval = window.setInterval(renderFrame, 1000 / fps);
    const capturedStream = canvas.captureStream(fps);

    // Audio mixing
    try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const audioCtx = new AudioCtx({ sampleRate: RECORDING_CONFIG.AUDIO.SAMPLE_RATE });
        const destination = audioCtx.createMediaStreamDestination();
        const compressor = audioCtx.createDynamicsCompressor();
        Object.assign(compressor.threshold, { value: RECORDING_CONFIG.AUDIO_MIXING.COMPRESSOR.THRESHOLD });
        Object.assign(compressor.knee, { value: RECORDING_CONFIG.AUDIO_MIXING.COMPRESSOR.KNEE });
        Object.assign(compressor.ratio, { value: RECORDING_CONFIG.AUDIO_MIXING.COMPRESSOR.RATIO });
        Object.assign(compressor.attack, { value: RECORDING_CONFIG.AUDIO_MIXING.COMPRESSOR.ATTACK });
        Object.assign(compressor.release, { value: RECORDING_CONFIG.AUDIO_MIXING.COMPRESSOR.RELEASE });

        let hasAudio = false;
        const addSource = (stream: MediaStream | null, gain: number) => {
            if (!stream) return;
            const tracks = stream.getAudioTracks();
            if (tracks.length === 0) return;
            hasAudio = true;
            const source = audioCtx.createMediaStreamSource(new MediaStream(tracks));
            const gainNode = audioCtx.createGain();
            gainNode.gain.value = gain;
            source.connect(gainNode).connect(compressor);
        };

        addSource(screenStream, RECORDING_CONFIG.AUDIO_MIXING.GAIN.SCREEN);
        addSource(audioStream, RECORDING_CONFIG.AUDIO_MIXING.GAIN.MICROPHONE);

        if (hasAudio) {
            compressor.connect(destination);
            const mixedTrack = destination.stream.getAudioTracks()[0];
            if (mixedTrack) capturedStream.addTrack(mixedTrack);
        }
    } catch {
        const fallback = screenStream?.getAudioTracks()[0] || audioStream?.getAudioTracks()[0];
        if (fallback) capturedStream.addTrack(fallback);
    }

    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (frameInterval) clearInterval(frameInterval);
        if (maskFrameHandle !== null && supportsFrameCallback) {
            maskVideo.cancelVideoFrameCallback(maskFrameHandle);
        }
        latestMask?.close();
        latestMask = null;
        screenVideo.pause(); screenVideo.srcObject = null;
        cameraVideo.pause(); cameraVideo.srcObject = null;
        capturedStream.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } });
        activeCleanups.delete(cleanup);
    };
    activeCleanups.add(cleanup);

    return {
        stream: capturedStream,
        cleanup,
        updateCameraPosition: (pos) => {
            camX = pos.x; camY = pos.y;
        },
        updateLayout: (l) => {
            // Layout changes only affect the overlay shape on the next recording.
            void l;
        },
    };
}

function coverCrop(srcW: number, srcH: number, targetAspect: number) {
    const srcAspect = srcW / srcH;
    let sx = 0, sy = 0, sWidth = srcW, sHeight = srcH;
    if (srcAspect > targetAspect) {
        sWidth = srcH * targetAspect;
        sx = (srcW - sWidth) / 2;
    } else {
        sHeight = srcW / targetAspect;
        sy = (srcH - sHeight) / 2;
    }
    return { sx, sy, sWidth, sHeight };
}

/**
 * Draw the camera with its background replaced by a solid color, using the
 * OS-provided segmentation mask (alpha cutout assumed; see MASK_INDICATES_BACKGROUND).
 * The video and mask are combined unmirrored on a scratch canvas, then drawn
 * mirrored into the overlay so both stay aligned.
 */
function drawCameraOverlayGreen(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    mask: ImageBitmap | null,
    x: number, y: number, w: number, h: number,
    layout: RecordingLayout,
    color: string
): void {
    const isCircle = layout === 'circle';
    const drawW = w;
    const drawH = isCircle ? w : h;

    const srcW = video.videoWidth || 1, srcH = video.videoHeight || 1;
    const { sx, sy, sWidth, sHeight } = coverCrop(srcW, srcH, drawW / drawH);

    const tmp = getTmpCanvas(drawW, drawH);
    const tctx = tmp.getContext('2d');
    if (!tctx) return;

    tctx.clearRect(0, 0, drawW, drawH);
    tctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, drawW, drawH);
    if (mask) {
        tctx.globalCompositeOperation = 'destination-in';
        tctx.filter = MASK_INDICATES_BACKGROUND ? 'invert(1)' : 'none';
        tctx.drawImage(mask, 0, 0, drawW, drawH);
        tctx.filter = 'none';
        tctx.globalCompositeOperation = 'source-over';
    }

    ctx.save();
    if (isCircle) {
        const r = drawW / 2, cx = x + r, cy = y + r;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.clip();
    } else {
        const cr = 12;
        ctx.beginPath();
        ctx.roundRect(x, y, drawW, drawH, cr);
        ctx.clip();
    }

    // Solid background in the clipped region
    ctx.fillStyle = color;
    ctx.fillRect(x, y, drawW, drawH);

    // Person (mirrored, matching the non-green overlay)
    ctx.translate(x + drawW, y);
    ctx.scale(-1, 1);
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    if (isCircle) {
        const r = drawW / 2;
        ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
    } else {
        ctx.roundRect(x, y, drawW, drawH, 12);
    }
    ctx.stroke();
}

/**
 * Camera-as-main-source with green screen: fill the whole canvas with the
 * chosen color (letterbox areas included) and composite the masked person
 * fitted into the canvas.
 */
function drawMainWithGreenScreen(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    mask: ImageBitmap | null,
    dx: number, dy: number, dw: number, dh: number,
    canvasW: number, canvasH: number,
    color: string
): void {
    const tmp = getTmpCanvas(canvasW, canvasH);
    const tctx = tmp.getContext('2d');
    if (!tctx) return;

    tctx.clearRect(0, 0, canvasW, canvasH);
    tctx.drawImage(video, dx, dy, dw, dh);
    if (mask) {
        tctx.globalCompositeOperation = 'destination-in';
        tctx.filter = MASK_INDICATES_BACKGROUND ? 'invert(1)' : 'none';
        tctx.drawImage(mask, dx, dy, dw, dh);
        tctx.filter = 'none';
        tctx.globalCompositeOperation = 'source-over';
    }

    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.drawImage(tmp, 0, 0);
}

function drawCameraOverlay(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    x: number, y: number, w: number, h: number,
    layout: RecordingLayout
): void {
    const srcW = video.videoWidth || 1, srcH = video.videoHeight || 1;

    if (layout === 'circle') {
        const r = w / 2, cx = x + r, cy = y + r;
        const crop = Math.min(srcW, srcH), sx = (srcW - crop) / 2, sy = (srcH - crop) / 2;
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
        ctx.translate(cx + r, cy - r); ctx.scale(-1, 1);
        ctx.drawImage(video, sx, sy, crop, crop, 0, 0, w, w);
        ctx.restore();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    } else {
        const cr = 12;
        const { sx, sy, sWidth, sHeight } = coverCrop(srcW, srcH, w / h);
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, cr);
        ctx.clip();
        ctx.translate(x + w, y); ctx.scale(-1, 1);
        ctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, w, h);
        ctx.restore();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.roundRect(x, y, w, h, cr); ctx.stroke();
    }
}
