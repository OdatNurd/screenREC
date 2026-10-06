/**
 * Applies an edit decision list to an indexed recording and emits a new
 * WebM file.
 *
 * Output is assembled mostly from verbatim encoded-block copies (lossless,
 * zero-copy via Blob slices). Only two things are ever synthesized:
 *   - the sub-GOP at a kept-segment start that falls mid-GOP in
 *     frame-accurate mode (re-encoded via WebCodecs, lazily imported), and
 *   - title-card segments (one WebCodecs keyframe held at low frame rate,
 *     plus Opus silence for the audio track).
 *
 * The rebuilt file always carries a real Duration header, so edited
 * recordings are seekable without the MediaRecorder duration hack.
 */

import {
  ID,
  element,
  floatElement,
  stringElement,
  uintElement,
  encodeVint,
  encodeId,
  concatParts,
  partSize,
} from './ebml';
import { gopAround, keyframeAtOrBefore } from './indexRecording';
import type {
  EdlState,
  GeneratedBlock,
  IndexedRecording,
  TitleCardSpec,
} from './types';

interface OutputItem {
  /** Timestamp on the output timeline (ms). */
  outMs: number;
  trackNumber: number;
  isKeyframe: boolean;
  /** Stable tiebreaker preserving source order at equal timestamps. */
  ord: number;
  /** Encoded frame payload bytes (everything after track VINT + timecode + flags). */
  data: Blob | Uint8Array;
  /** Original flags byte when copied; null when generated. */
  flags: number | null;
}

const CLUSTER_MAX_SPAN_MS = 3000;
const CARD_VIDEO_TICK_MS = 250; // static card: 4 fps holds perfectly, tiny size
const OPUS_SILENCE = Uint8Array.of(0xf8, 0xff, 0xfe); // 20 ms DTX/PLC frame

/** Snap a segment start backward to the previous keyframe (defensive for snap mode). */
function snappedStart(index: IndexedRecording, ms: number): number {
  const kf = keyframeAtOrBefore(index, ms);
  return kf === null ? ms : Math.max(kf, 0);
}

interface SourceRange {
  startMs: number;
  endMs: number;
}

/** Compute kept source ranges (ms) from trim + cuts, sorted and clamped. */
export function keptRanges(index: IndexedRecording, edl: EdlState): SourceRange[] {
  const total = index.durationMs;
  const lo = Math.max(0, Math.min(edl.trimStartMs, total));
  const hi = Math.max(lo, Math.min(edl.trimEndMs, total));
  const gaps = edl.cuts
    .map((c) => ({
      startMs: Math.max(lo, Math.min(c.startMs, hi)),
      endMs: Math.max(lo, Math.min(c.endMs, hi)),
    }))
    .filter((c) => c.endMs > c.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const ranges: SourceRange[] = [];
  let cursor = lo;
  for (const gap of gaps) {
    if (gap.startMs > cursor) ranges.push({ startMs: cursor, endMs: gap.startMs });
    cursor = Math.max(cursor, gap.endMs);
  }
  if (hi > cursor) ranges.push({ startMs: cursor, endMs: hi });
  return ranges;
}

/** Rough output size estimate (bytes) for the download dialog. */
export function estimateEditedBytes(index: IndexedRecording, edl: EdlState): number {
  const total = Math.max(1, index.durationMs);
  const kept = keptRanges(index, edl).reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
  const cardOverhead = edl.cards.reduce((sum, c) => sum + c.durationMs * 100, 0);
  return Math.round((index.blob.size * kept) / total) + cardOverhead;
}

function encodeBlockBody(trackNumber: number, relTimeMs: number, flags: number, payload: Blob | Uint8Array): (Uint8Array | Blob)[] {
  const trackVint = encodeVint(trackNumber);
  const header = new Uint8Array(trackVint.length + 3);
  header.set(trackVint, 0);
  const rel = Math.max(-32768, Math.min(32767, Math.round(relTimeMs)));
  header[trackVint.length] = (rel >> 8) & 0xff;
  header[trackVint.length + 1] = rel & 0xff;
  header[trackVint.length + 2] = flags;
  return [header, payload];
}

/** Generated blocks for a title card: held keyframe video + Opus silence. */
function titleCardBlocks(spec: TitleCardSpec, videoTrack: number | null, audioTrack: number | null, keyframeData: Uint8Array): GeneratedBlock[] {
  const out: GeneratedBlock[] = [];
  if (videoTrack !== null) {
    for (let t = 0; t < spec.durationMs; t += CARD_VIDEO_TICK_MS) {
      out.push({ timeMs: t, trackNumber: videoTrack, isKeyframe: true, data: keyframeData });
    }
  }
  if (audioTrack !== null) {
    for (let t = 0; t < spec.durationMs; t += 20) {
      out.push({ timeMs: t, trackNumber: audioTrack, isKeyframe: true, data: OPUS_SILENCE });
    }
  }
  return out;
}

/**
 * Render the EDL to a new WebM Blob.
 *
 * `generateCard` and `reencodeSubGop` are injected by the caller (they need
 * WebCodecs + canvas and live in ./webcodecs, lazily imported by the app).
 */
export async function renderEdl(
  index: IndexedRecording,
  edl: EdlState,
  hooks: {
    generateCard?: (spec: TitleCardSpec) => Promise<Uint8Array>;
    reencodeSubGop?: (fromMs: number, toMs: number) => Promise<GeneratedBlock[]>;
    onProgress?: (fraction: number) => void;
  } = {}
): Promise<Blob> {
  const { video, audio, blob } = index;
  const ranges = keptRanges(index, edl);

  // Cards placed inside kept ranges, in source-time order.
  const cards = edl.cards
    .map((card) => ({ card, at: Math.max(0, Math.min(card.atMs, index.durationMs)) }))
    .sort((a, b) => a.at - b.at);

  const items: OutputItem[] = [];
  let outCursor = 0;
  let ord = 0;

  const pushGenerated = (gen: GeneratedBlock[], offsetMs: number) => {
    for (const g of gen) {
      items.push({
        outMs: offsetMs + g.timeMs,
        trackNumber: g.trackNumber,
        isKeyframe: g.isKeyframe,
        ord: ord++,
        data: g.data,
        flags: g.isKeyframe ? 0x80 : 0x00,
      });
    }
  };

  for (const range of ranges) {
    // Split the range at card insertion points.
    const splits: { startMs: number; endMs: number; card?: TitleCardSpec }[] = [];
    let cursor = range.startMs;
    for (const { card, at } of cards) {
      if (at >= cursor && at < range.endMs) {
        splits.push({ startMs: cursor, endMs: at });
        splits.push({ startMs: at, endMs: at, card });
        cursor = at;
      }
    }
    splits.push({ startMs: cursor, endMs: range.endMs });

    for (const split of splits) {
      if (split.card) {
        if (!hooks.generateCard) {
          throw new Error('renderEdl: title card in EDL but no generateCard hook supplied');
        }
        const keyframeData = await hooks.generateCard(split.card);
        pushGenerated(
          titleCardBlocks(split.card, video?.trackNumber ?? null, audio?.trackNumber ?? null, keyframeData),
          outCursor
        );
        outCursor += split.card.durationMs;
        continue;
      }
      if (split.endMs <= split.startMs) continue;

      let copyFrom = split.startMs;
      // Lower bound for audio blocks. Only video is ever replaced by generated
      // frames; Opus frames are independent, so audio must pass through from
      // the segment start even across a re-encoded sub-GOP. Skipping it there
      // opened an audio gap of up to one full GOP at every such join.
      let audioFrom = split.startMs;
      // The source timestamp that maps to the start of this output segment.
      let mapFrom = split.startMs;

      // Frame-accurate: a kept segment start that is not a keyframe needs its
      // sub-GOP re-encoded (decode from the previous keyframe, keep the tail).
      const isKeyStart = keyframeAtOrBefore(index, split.startMs) === split.startMs;
      if (!isKeyStart) {
        // A kept segment that starts mid-GOP is not decodable as-is.
        // Re-encode just the sub-GOP tail via WebCodecs so the join lands on
        // the exact requested frame (also used to resume right after a title
        // card, which is a synthesized segment and never keyframe-aligned).
        if (hooks.reencodeSubGop) {
          const gop = gopAround(index, split.startMs);
          const patchEnd = Math.min(gop.nextKeyframeMs, split.endMs);
          const gen = await hooks.reencodeSubGop(split.startMs, patchEnd);
          // Generated times are relative to split.startMs; shift to output ms.
          pushGenerated(gen, outCursor);
          copyFrom = patchEnd;
        } else if (edl.snapToKeyframes) {
          // No WebCodecs available (tests): snap back to the previous
          // keyframe — keeps slightly more content, never loses wanted media.
          copyFrom = snappedStart(index, split.startMs);
          audioFrom = copyFrom;
          mapFrom = copyFrom;
        } else {
          throw new Error('renderEdl: frame-accurate cut in EDL but no reencodeSubGop hook supplied');
        }
      }

      // Copy blocks verbatim, re-timecoded: video from `copyFrom` (earlier
      // video is replaced by the re-encoded mini-GOP), audio from `audioFrom`.
      for (const block of index.blocks) {
        const isVideoBlock = video != null && block.trackNumber === video.trackNumber;
        if (block.timeMs < (isVideoBlock ? copyFrom : audioFrom)) continue;
        if (block.timeMs >= split.endMs) break;
        if (!video && !audio) continue;

        const payload = blob.slice(
          block.bodyOffset + block.trackVintLen + 3,
          block.bodyOffset + block.bodySize
        );
        const head = await blob
          .slice(block.bodyOffset + block.trackVintLen + 2, block.bodyOffset + block.trackVintLen + 3)
          .arrayBuffer();
        // Force the keyframe bit from indexed truth (Chrome omits it for VP9);
        // keep the remaining flag bits (lacing, priority) verbatim.
        const flags = (new Uint8Array(head)[0] & 0x7f) | (block.isKeyframe ? 0x80 : 0x00);

        items.push({
          outMs: outCursor + (block.timeMs - mapFrom),
          trackNumber: block.trackNumber,
          isKeyframe: block.isKeyframe,
          ord: ord++,
          data: payload,
          flags,
        });
      }
      outCursor += split.endMs - mapFrom;
    }
  }

  hooks.onProgress?.(0.5);

  // Order output blocks by timestamp, video before audio at equal timestamps.
  const isVideoTrack = video?.trackNumber ?? -1;
  items.sort((a, b) =>
    a.outMs - b.outMs ||
    (a.trackNumber === isVideoTrack ? 0 : 1) - (b.trackNumber === isVideoTrack ? 0 : 1) ||
    a.ord - b.ord
  );

  // ---- Write the output WebM ----

  const ebmlHeader = element(ID.EBML, concat([
    uintElement(0x4286, 1), // EBMLVersion
    uintElement(0x42f7, 1), // EBMLReadVersion
    uintElement(0x42f2, 4), // EBMLMaxIDLength
    uintElement(0x42f3, 8), // EBMLMaxSizeLength
    stringElement(0x4282, 'webm'), // DocType
    uintElement(0x4287, 2), // DocTypeVersion
    uintElement(0x4285, 2), // DocTypeReadVersion
  ]));

  const info = element(ID.INFO, concat([
    uintElement(ID.TIMECODE_SCALE, index.timecodeScaleNs),
    floatElement(ID.DURATION, outCursor * (index.timecodeScaleNs / 1_000_000)),
    stringElement(ID.MUXING_APP, 'screenREC'),
    stringElement(ID.WRITING_APP, 'screenREC'),
  ]));

  const tracksBody = new Uint8Array(
    await blob.slice(index.tracksStart, index.tracksEnd).arrayBuffer()
  );
  const tracks = element(ID.TRACKS, tracksBody);

  // Group blocks into clusters and record cluster byte offsets for Cues.
  interface ClusterDraft {
    timeMs: number;
    parts: (Uint8Array | Blob)[];
    size: number;
    hasVideo: boolean;
  }
  const clusters: ClusterDraft[] = [];
  let current: ClusterDraft | null = null;

  for (const item of items) {
    if (!current || item.outMs - current.timeMs > CLUSTER_MAX_SPAN_MS || item.outMs < current.timeMs) {
      current = { timeMs: item.outMs, parts: [], size: 0, hasVideo: false };
      clusters.push(current);
    }
    const rel = item.outMs - current.timeMs;
    const body = encodeBlockBody(item.trackNumber, rel, item.flags ?? 0, item.data);
    const bodySize = body.reduce((n, part) => n + partSize(part), 0);
    const blockElem = concat([encodeId(ID.SIMPLE_BLOCK), encodeVint(bodySize), body]);
    current.parts.push(blockElem);
    current.size += partSize(blockElem);
    if (item.trackNumber === isVideoTrack) current.hasVideo = true;
  }

  const clusterSections: (Uint8Array | Blob)[] = [];
  let clusterOffset = 0;
  const cueEntries: { timeMs: number; offset: number }[] = [];
  for (const cluster of clusters) {
    const timecodeElem = uintElement(ID.TIMECODE, Math.round(cluster.timeMs));
    const bodySize = timecodeElem.length + cluster.size;
    const clusterElem = concat([
      encodeId(ID.CLUSTER),
      encodeVint(bodySize),
      timecodeElem,
      cluster.parts,
    ]);
    if (cluster.hasVideo) cueEntries.push({ timeMs: cluster.timeMs, offset: clusterOffset });
    clusterSections.push(clusterElem);
    clusterOffset += clusterElem instanceof Uint8Array ? clusterElem.length : clusterElem.size;
  }

  // Cues reference cluster positions relative to the start of Segment data.
  const infoTracksSize = partSize(info) + partSize(tracks);
  const cuePoints = cueEntries.map((cue) =>
    element(ID.CUE_POINT, concat([
      uintElement(ID.CUE_TIME, Math.round(cue.timeMs)),
      element(ID.CUE_TRACK_POSITIONS, concat([
        uintElement(ID.CUE_TRACK, video?.trackNumber ?? 1),
        uintElement(ID.CUE_CLUSTER_POSITION, infoTracksSize + cue.offset),
      ])),
    ]))
  );
  const cues = element(ID.CUES, concat(cuePoints));

  const segmentBody = concat([info, tracks, ...clusterSections, cues]);
  const segment = concat([encodeId(ID.SEGMENT), encodeVint(partSize(segmentBody)), segmentBody]);

  hooks.onProgress?.(1);
  return new Blob([ebmlHeader, segment] as BlobPart[], { type: 'video/webm' });
}

/** Flatten nested part lists, then concatenate zero-copy. */
function concat(parts: (Uint8Array | Blob | (Uint8Array | Blob)[])[]): Uint8Array | Blob {
  const flat: (Uint8Array | Blob)[] = [];
  for (const p of parts) {
    if (Array.isArray(p)) flat.push(...p);
    else flat.push(p);
  }
  return concatParts(flat);
}
