/**
 * Browser-side WebCodecs helpers for the edit engine.
 *
 * These are the only parts of the pipeline that touch decoded pixels:
 *   - grabbing a still frame for a title card (and its live preview),
 *   - re-encoding the sub-GOP tail at a frame-accurate join,
 *   - rendering/encoding a title card (held frame + styled text overlay).
 * Everything else in the edit pipeline is lossless container surgery.
 */

import type {
  GeneratedBlock,
  IndexedRecording,
  TitleCardSpec,
} from './types';

function videoConfig(index: IndexedRecording): VideoDecoderConfig {
  const v = index.video;
  if (!v) throw new Error('webcodecs: recording has no video track');
  const config: VideoDecoderConfig = {
    codec: v.codec,
    codedWidth: v.width,
    codedHeight: v.height,
    optimizeForLatency: true,
  };
  if (v.codecPrivate && v.codecPrivate.length > 0) {
    config.description = v.codecPrivate.slice();
  }
  return config;
}

function estimateBitrate(index: IndexedRecording): number {
  const seconds = Math.max(1, index.durationMs / 1000);
  const bps = (index.blob.size * 8) / seconds;
  return Math.min(8_000_000, Math.max(1_500_000, Math.round(bps * 1.25)));
}

async function decodeVideoRange(
  index: IndexedRecording,
  fromMs: number,
  toMs: number
): Promise<VideoFrame[]> {
  const v = index.video;
  if (!v) throw new Error('webcodecs: recording has no video track');
  const blocks = index.blocks.filter(
    (b) => b.trackNumber === v.trackNumber && b.timeMs >= fromMs && b.timeMs < toMs
  );
  if (blocks.length === 0) return [];

  const frames: VideoFrame[] = [];
  let decodeError: unknown = null;
  const decoder = new VideoDecoder({
    output: (frame) => frames.push(frame),
    error: (e) => { decodeError = e; },
  });
  decoder.configure(videoConfig(index));

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const data = new Uint8Array(
      await index.blob
        .slice(b.bodyOffset + b.trackVintLen + 3, b.bodyOffset + b.bodySize)
        .arrayBuffer()
    );
    const durationUs = i + 1 < blocks.length ? (blocks[i + 1].timeMs - b.timeMs) * 1000 : 33_333;
    decoder.decode(
      new EncodedVideoChunk({
        type: b.isKeyframe ? 'key' : 'delta',
        timestamp: b.timeMs * 1000,
        duration: durationUs,
        data,
      })
    );
  }
  await decoder.flush();
  decoder.close();
  if (decodeError) {
    for (const f of frames) f.close();
    throw decodeError;
  }
  return frames;
}

async function encodeFrame(
  index: IndexedRecording,
  frame: VideoFrame,
  keyFrame: boolean
): Promise<EncodedVideoChunk | null> {
  let out: EncodedVideoChunk | null = null;
  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk) => { out = chunk; },
    error: (e) => { encodeError = e; },
  });
  const v = index.video!;
  encoder.configure({
    codec: v.codec,
    width: v.width,
    height: v.height,
    bitrate: estimateBitrate(index),
    framerate: 30,
    latencyMode: 'quality',
  });
  encoder.encode(frame, { keyFrame });
  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;
  return out;
}

/**
 * Re-encode the tail of one GOP: decode from the GOP's keyframe, keep frames
 * in [fromMs, toMs), and emit them as a fresh mini-GOP whose first frame is a
 * keyframe — so a kept segment can start at exactly `fromMs`.
 */
export async function reencodeSubGop(
  index: IndexedRecording,
  fromMs: number,
  toMs: number
): Promise<GeneratedBlock[]> {
  const v = index.video;
  if (!v) throw new Error('webcodecs: recording has no video track');
  // Decode from the keyframe covering `fromMs` so deltas can be reconstructed.
  let gopStart = 0;
  for (const kf of index.keyframesMs) {
    if (kf <= fromMs) gopStart = kf;
    else break;
  }
  const frames = await decodeVideoRange(index, gopStart, toMs);
  const out: GeneratedBlock[] = [];
  try {
    let first = true;
    for (const frame of frames) {
      const timeMs = frame.timestamp / 1000;
      if (timeMs < fromMs) continue;
      const chunk = await encodeFrame(index, frame, first);
      first = false;
      if (chunk) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        out.push({
          timeMs: timeMs - fromMs,
          trackNumber: v.trackNumber,
          isKeyframe: chunk.type === 'key',
          data,
        });
      }
    }
  } finally {
    for (const f of frames) f.close();
  }
  return out;
}

/**
 * Capture the video frame at `atMs` (decoded from its GOP). The caller must
 * close the returned frame.
 */
export async function grabFrame(index: IndexedRecording, atMs: number): Promise<VideoFrame> {
  let gopStart = 0;
  let nextKf = Infinity;
  for (const kf of index.keyframesMs) {
    if (kf <= atMs) gopStart = kf;
    else { nextKf = kf; break; }
  }
  const frames = await decodeVideoRange(index, gopStart, Math.min(nextKf, atMs + 4000));
  if (frames.length === 0) throw new Error('webcodecs: no decodable frame near insertion point');
  // The frame at or nearest after atMs; otherwise the last decoded one.
  let best = frames[frames.length - 1];
  for (const f of frames) {
    if (f.timestamp / 1000 >= atMs) { best = f; break; }
  }
  for (const f of frames) {
    if (f !== best) f.close();
  }
  return best;
}

function wrapText(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Draw a title card (frozen frame + styled text panel) onto a 2D context.
 * Shared by the encoder and the live modal preview so what you see is what
 * gets muxed.
 */
export function drawTitleCard(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frame: CanvasImageSource,
  spec: TitleCardSpec,
  width: number,
  height: number
): void {
  // Frozen source frame underneath.
  ctx.drawImage(frame, 0, 0, width, height);

  // Text panel, positioned like the camera overlay (normalized box).
  const boxX = spec.box.x * width;
  const boxY = spec.box.y * height;
  const boxW = spec.box.w * width;
  const boxH = spec.box.h * height;
  const radius = Math.min(boxW, boxH) * 0.12;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, radius);
  ctx.fillStyle = spec.bgColor;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = Math.max(1, height / 540);
  ctx.stroke();
  ctx.restore();

  const fontSize = Math.max(12, spec.fontSizePct * height);
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  ctx.fillStyle = spec.textColor;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const padX = fontSize * 0.75;
  const lines = wrapText(ctx, spec.text, Math.max(10, boxW - padX * 2));
  const lineHeight = fontSize * 1.3;
  const maxLines = Math.max(1, Math.floor((boxH - lineHeight * 0.6) / lineHeight));
  const visible = lines.slice(0, maxLines);
  const totalH = visible.length * lineHeight;
  let y = boxY + boxH / 2 - totalH / 2 + lineHeight / 2;
  for (const line of visible) {
    ctx.fillText(line, boxX + boxW / 2, y, boxW - padX * 2);
    y += lineHeight;
  }
}

/**
 * Render the title card frame (captured still + styled text panel) and encode
 * it as a single keyframe. Returns the encoded frame bytes; the renderer muxes
 * it repeatedly to hold it on screen for the card's duration.
 */
export async function generateTitleCard(
  index: IndexedRecording,
  spec: TitleCardSpec
): Promise<Uint8Array> {
  const v = index.video;
  if (!v) throw new Error('webcodecs: recording has no video track');
  const frame = await grabFrame(index, spec.atMs);
  let chunk: EncodedVideoChunk | null = null;
  try {
    const canvas = new OffscreenCanvas(v.width, v.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('webcodecs: 2d canvas unavailable');

    drawTitleCard(ctx, frame, spec, v.width, v.height);

    const outFrame = new VideoFrame(canvas, {
      timestamp: 0,
      duration: 33_333,
    });
    chunk = await encodeFrame(index, outFrame, true);
    outFrame.close();
  } finally {
    frame.close();
  }
  if (!chunk) throw new Error('webcodecs: title card encode produced no frame');
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return data;
}
