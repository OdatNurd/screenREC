/**
 * Indexes a MediaRecorder WebM blob: track metadata, a keyframe map, and a
 * byte-level block directory. Only small headers are read from the blob —
 * frame payloads are never loaded during indexing.
 */

import {
  ID,
  parseVint,
  readElementHeader,
  type ElementHeader,
} from './ebml';
import type {
  AudioTrackInfo,
  BlockRef,
  IndexedRecording,
  VideoTrackInfo,
} from './types';

/** Map a Matroska CodecID to a WebCodecs codec string. */
export function webCodecsCodec(codecId: string): string {
  switch (codecId) {
    case 'V_VP8':
      return 'vp8';
    case 'V_VP9':
      // Level 1.0, 8-bit 4:2:0 — the profile MediaRecorder emits.
      return 'vp09.00.10.08';
    case 'V_AV1':
      return 'av01.0.04M.08';
    case 'A_OPUS':
      return 'opus';
    case 'A_VORBIS':
      return 'vorbis';
    default:
      return codecId;
  }
}

function readUint(buf: Uint8Array): number {
  let value = 0;
  for (let i = 0; i < buf.length; i++) value = value * 256 + buf[i];
  return value;
}

function readFloat(buf: Uint8Array): number {
  if (buf.length === 4) return new DataView(buf.buffer, buf.byteOffset).getFloat32(0, false);
  return new DataView(buf.buffer, buf.byteOffset).getFloat64(0, false);
}

function readAscii(buf: Uint8Array): string {
  return new TextDecoder('ascii').decode(buf).replace(/\0+$/, '');
}

/** Read `length` bytes at absolute `offset` as a Uint8Array. */
async function readBytes(blob: Blob, offset: number, length: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
}

async function parseTrackEntry(
  blob: Blob,
  header: ElementHeader
): Promise<VideoTrackInfo | AudioTrackInfo | null> {
  let trackNumber = 0;
  let trackType = 0;
  let codecId = '';
  let codecPrivate: Uint8Array | undefined;
  let width = 0;
  let height = 0;
  let sampleRate = 48000;
  let channels = 1;

  let pos = header.bodyStart;
  while (pos < header.bodyEnd) {
    const el = await readElementHeader(blob, pos, header.bodyEnd, false);
    if (!el) break;
    const body = await readBytes(blob, el.bodyStart, el.bodyEnd - el.bodyStart);
    switch (el.id) {
      case ID.TRACK_NUMBER: trackNumber = readUint(body); break;
      case ID.TRACK_TYPE: trackType = readUint(body); break;
      case ID.CODEC_ID: codecId = readAscii(body); break;
      case ID.CODEC_PRIVATE: codecPrivate = body; break;
      case ID.VIDEO: {
        let vpos = el.bodyStart;
        while (vpos < el.bodyEnd) {
          const v = await readElementHeader(blob, vpos, el.bodyEnd, false);
          if (!v) break;
          const vb = await readBytes(blob, v.bodyStart, v.bodyEnd - v.bodyStart);
          if (v.id === ID.PIXEL_WIDTH) width = readUint(vb);
          if (v.id === ID.PIXEL_HEIGHT) height = readUint(vb);
          vpos = v.nextOffset;
        }
        break;
      }
      case ID.AUDIO: {
        let apos = el.bodyStart;
        while (apos < el.bodyEnd) {
          const a = await readElementHeader(blob, apos, el.bodyEnd, false);
          if (!a) break;
          const ab = await readBytes(blob, a.bodyStart, a.bodyEnd - a.bodyStart);
          if (a.id === ID.SAMPLING_FREQUENCY) sampleRate = readFloat(ab);
          if (a.id === ID.CHANNELS) channels = readUint(ab);
          apos = a.nextOffset;
        }
        break;
      }
    }
    pos = el.nextOffset;
  }

  if (!trackNumber || !codecId) return null;
  const codec = webCodecsCodec(codecId);
  if (trackType === 1) {
    return { trackNumber, codecId, codec, width, height, codecPrivate };
  }
  if (trackType === 2) {
    return { trackNumber, codecId, codec, sampleRate, channels, codecPrivate };
  }
  return null;
}

/**
 * Detect a keyframe from the codec frame header. Chrome's WebM muxer does not
 * set the SimpleBlock keyframe flag for VP9, so the container flag cannot be
 * trusted; the VP8/VP9 frame headers carry the ground truth in their first
 * bytes.
 */
export function sniffKeyframe(codecId: string, data: Uint8Array): boolean | null {
  if (data.length < 1) return null;
  if (codecId === 'V_VP8') {
    // Uncompressed header: bit 0 of the first byte is 0 for a keyframe.
    return (data[0] & 0x01) === 0;
  }
  if (codecId === 'V_VP9') {
    if (data.length < 2) return null;
    const bit = (i: number) => (i < 8 ? (data[0] >> (7 - i)) & 1 : (data[1] >> (15 - i)) & 1);
    // frame_marker must be 0b10
    if (bit(0) !== 1 || bit(1) !== 0) return null;
    const profileLow = bit(2);
    const profileHigh = bit(3);
    const profile = (profileHigh << 1) | profileLow;
    let i = 4;
    if (profile === 3) i += 1; // reserved zero bit
    const showExistingFrame = bit(i);
    i += 1;
    if (showExistingFrame) return false;
    return bit(i) === 0; // frame_type: 0 = KEY_FRAME
  }
  return null;
}

/**
 * Parse a SimpleBlock or Block body header.
 * Body layout: track-number VINT, int16 big-endian relative timecode, flags.
 */
export async function parseBlockHeader(
  blob: Blob,
  bodyOffset: number,
  bodySize: number
): Promise<{ trackNumber: number; trackVintLen: number; relTimeMs: number; flags: number; frameHead: Uint8Array } | null> {
  const headLen = Math.min(bodySize, 16);
  const head = await readBytes(blob, bodyOffset, headLen);
  // Block track numbers are size-style VINTs (marker bit stripped).
  const trackV = parseVint(head, 0, false);
  if (!trackV) return null;
  const rel = (head[trackV.length] << 8) | head[trackV.length + 1];
  // int16 signed
  const relTimeMs = rel > 0x7fff ? rel - 0x10000 : rel;
  const flags = head[trackV.length + 2] ?? 0;
  return {
    trackNumber: trackV.value,
    trackVintLen: trackV.length,
    relTimeMs,
    flags,
    frameHead: head.subarray(trackV.length + 3),
  };
}

/** Index a recorded WebM blob for editing. */
export async function indexRecording(blob: Blob): Promise<IndexedRecording> {
  const size = blob.size;
  let timecodeScaleNs = 1_000_000;
  let video: VideoTrackInfo | null = null;
  let audio: AudioTrackInfo | null = null;
  let tracksStart = 0;
  let tracksEnd = 0;
  const blocks: BlockRef[] = [];

  // Find the Segment element at top level.
  let pos = 0;
  let segmentEnd = size;
  while (pos < size) {
    const el = await readElementHeader(blob, pos, size);
    if (!el) break;
    if (el.id === ID.SEGMENT) {
      segmentEnd = el.bodyEnd;
      pos = el.bodyStart;
      break;
    }
    pos = el.nextOffset;
  }

  while (pos < segmentEnd) {
    const el = await readElementHeader(blob, pos, segmentEnd);
    if (!el) break;

    if (el.id === ID.INFO) {
      let ipos = el.bodyStart;
      while (ipos < el.bodyEnd) {
        const info = await readElementHeader(blob, ipos, el.bodyEnd, false);
        if (!info) break;
        if (info.id === ID.TIMECODE_SCALE) {
          const b = await readBytes(blob, info.bodyStart, info.bodyEnd - info.bodyStart);
          timecodeScaleNs = readUint(b);
        }
        ipos = info.nextOffset;
      }
    } else if (el.id === ID.TRACKS) {
      // Body range of the Tracks element (copied verbatim on output).
      tracksStart = el.bodyStart;
      tracksEnd = el.bodyEnd;
      let tpos = el.bodyStart;
      while (tpos < el.bodyEnd) {
        const entry = await readElementHeader(blob, tpos, el.bodyEnd, false);
        if (!entry) break;
        if (entry.id === ID.TRACK_ENTRY) {
          const parsed = await parseTrackEntry(blob, entry);
          if (parsed && 'width' in parsed) video = parsed;
          else if (parsed && 'sampleRate' in parsed) audio = parsed;
        }
        tpos = entry.nextOffset;
      }
    } else if (el.id === ID.CLUSTER) {
      let clusterTimeMs = 0;
      // Chrome's streaming muxer writes consecutive unknown-size Clusters,
      // so an unknown-size cluster ends where the next sibling element
      // (another Cluster, Cues, ...) begins. Track that boundary.
      let innerEnd = el.bodyEnd;
      const isClusterChild = (id: number) =>
        id === ID.TIMECODE || id === ID.SIMPLE_BLOCK || id === ID.BLOCK_GROUP;

      // First pass: find the cluster Timecode element.
      let cpos = el.bodyStart;
      while (cpos < el.bodyEnd) {
        const child = await readElementHeader(blob, cpos, el.bodyEnd, false);
        if (!child) { innerEnd = cpos; break; }
        if (!isClusterChild(child.id)) { innerEnd = cpos; break; }
        if (child.id === ID.TIMECODE) {
          const b = await readBytes(blob, child.bodyStart, child.bodyEnd - child.bodyStart);
          clusterTimeMs = readUint(b);
          break;
        }
        cpos = child.nextOffset;
      }
      // Second pass: blocks (no unknown sizes allowed below Cluster level).
      cpos = el.bodyStart;
      while (cpos < el.bodyEnd) {
        const child = await readElementHeader(blob, cpos, el.bodyEnd, false);
        if (!child) { innerEnd = cpos; break; }
        if (!isClusterChild(child.id)) { innerEnd = cpos; break; }
        if (child.id === ID.SIMPLE_BLOCK) {
          const hdr = await parseBlockHeader(blob, child.bodyStart, child.bodyEnd - child.bodyStart);
          if (hdr) {
            const sniffed =
              video !== null && hdr.trackNumber === video.trackNumber
                ? sniffKeyframe(video.codecId, hdr.frameHead)
                : null;
            blocks.push({
              timeMs: clusterTimeMs + hdr.relTimeMs,
              trackNumber: hdr.trackNumber,
              isKeyframe: sniffed !== null ? sniffed : (hdr.flags & 0x80) !== 0,
              bodyOffset: child.bodyStart,
              bodySize: child.bodyEnd - child.bodyStart,
              trackVintLen: hdr.trackVintLen,
            });
          }
        } else if (child.id === ID.BLOCK_GROUP) {
          let isKeyframe = true;
          let blockHeader: ElementHeader | null = null;
          let bpos = child.bodyStart;
          while (bpos < child.bodyEnd) {
            const be = await readElementHeader(blob, bpos, child.bodyEnd, false);
            if (!be) break;
            if (be.id === ID.REFERENCE_BLOCK) isKeyframe = false;
            if (be.id === ID.BLOCK) blockHeader = be;
            bpos = be.nextOffset;
          }
          if (blockHeader) {
            const hdr = await parseBlockHeader(
              blob,
              blockHeader.bodyStart,
              blockHeader.bodyEnd - blockHeader.bodyStart
            );
            if (hdr) {
              const sniffed =
                video !== null && hdr.trackNumber === video.trackNumber
                  ? sniffKeyframe(video.codecId, hdr.frameHead)
                  : null;
              blocks.push({
                timeMs: clusterTimeMs + hdr.relTimeMs,
                trackNumber: hdr.trackNumber,
                isKeyframe: sniffed !== null ? sniffed : isKeyframe,
                bodyOffset: blockHeader.bodyStart,
                bodySize: blockHeader.bodyEnd - blockHeader.bodyStart,
                trackVintLen: hdr.trackVintLen,
              });
            }
          }
        }
        cpos = child.nextOffset;
      }
      // An unknown-size cluster ends at the boundary element found above.
      pos = el.size === null ? innerEnd : el.nextOffset;
      continue;
    }

    pos = el.nextOffset;
  }

  // Blocks should already be in decode order; sort stably by time as a guard.
  blocks.sort((a, b) => a.timeMs - b.timeMs);

  const keyframesMs: number[] = [];
  if (video) {
    for (const b of blocks) {
      if (b.trackNumber === video.trackNumber && b.isKeyframe) keyframesMs.push(b.timeMs);
    }
  }

  let durationMs = 0;
  for (const b of blocks) durationMs = Math.max(durationMs, b.timeMs);
  // Nudge past the last block timestamp so trimEnd can reach the true end.
  durationMs += 33;

  return {
    blob,
    timecodeScaleNs,
    durationMs,
    video,
    audio,
    keyframesMs,
    blocks,
    tracksStart,
    tracksEnd,
  };
}

/** Find the GOP (keyframe interval) containing `fromMs`. */
export function gopAround(index: IndexedRecording, fromMs: number): { gopStartMs: number; nextKeyframeMs: number } {
  const kf = index.keyframesMs;
  let gopStartMs = kf.length ? kf[0] : 0;
  let nextKeyframeMs = Infinity;
  for (let i = 0; i < kf.length; i++) {
    if (kf[i] <= fromMs) gopStartMs = kf[i];
    else {
      nextKeyframeMs = kf[i];
      break;
    }
  }
  return { gopStartMs, nextKeyframeMs };
}

/** Largest keyframe timestamp ≤ `fromMs` (null when before the first). */
export function keyframeAtOrBefore(index: IndexedRecording, fromMs: number): number | null {
  let result: number | null = null;
  for (const kf of index.keyframesMs) {
    if (kf <= fromMs) result = kf;
    else break;
  }
  return result;
}

/** Smallest keyframe timestamp ≥ `fromMs` (null when none). */
export function keyframeAtOrAfter(index: IndexedRecording, fromMs: number): number | null {
  for (const kf of index.keyframesMs) {
    if (kf >= fromMs) return kf;
  }
  return null;
}
