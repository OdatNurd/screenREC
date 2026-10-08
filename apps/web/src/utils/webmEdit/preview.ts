/**
 * WYSIWYG playback schedule for the edit timeline.
 *
 * Maps between the source timeline the <video> element plays and the edited
 * (output) timeline the export produces. The layout mirrors renderEdl's
 * exactly: kept spans pass through 1:1 in time, each title card inserts its
 * duration at its insertion point, removed regions simply do not exist.
 */

import type { EdlState, IndexedRecording, TitleCardSpec } from './types';
import { keptRanges } from './renderEdl';

export interface PreviewSegment {
  /** 'source' = copied footage, 'card' = title-card hold. */
  kind: 'source' | 'card';
  /** Output-timeline start (ms). */
  outMs: number;
  /** Source-timeline start (ms); for cards, the insertion point. */
  fromMs: number;
  /** Source-timeline end (ms); for cards, equal to fromMs. */
  toMs: number;
  /** Duration on the output timeline (ms). */
  durationMs: number;
  card?: TitleCardSpec;
}

/** Build the playback schedule for an EDL (segments in output order). */
export function buildPreviewSegments(index: IndexedRecording, edl: EdlState): PreviewSegment[] {
  const ranges = keptRanges(index, edl);
  const cards = edl.cards
    .map((card) => ({ card, at: Math.max(0, Math.min(card.atMs, index.durationMs)) }))
    .sort((a, b) => a.at - b.at);

  const segments: PreviewSegment[] = [];
  let outMs = 0;
  for (const range of ranges) {
    let cursor = range.startMs;
    for (const { card, at } of cards) {
      // Same placement rule as renderEdl: a card plays when its insertion
      // point falls inside a kept range.
      if (at >= cursor && at < range.endMs) {
        if (at > cursor) {
          segments.push({ kind: 'source', outMs, fromMs: cursor, toMs: at, durationMs: at - cursor });
          outMs += at - cursor;
        }
        segments.push({ kind: 'card', outMs, fromMs: at, toMs: at, durationMs: card.durationMs, card });
        outMs += card.durationMs;
        cursor = at;
      }
    }
    if (range.endMs > cursor) {
      segments.push({ kind: 'source', outMs, fromMs: cursor, toMs: range.endMs, durationMs: range.endMs - cursor });
      outMs += range.endMs - cursor;
    }
  }
  return segments;
}

/** Total output duration of the schedule (ms). */
export function previewDurationMs(segments: PreviewSegment[]): number {
  const last = segments[segments.length - 1];
  return last ? last.outMs + last.durationMs : 0;
}

/**
 * Source ms -> output ms. A card's insertion point maps to the START of the
 * card's output span. Positions in removed regions map to where playback
 * would resume (the next kept point).
 */
export function toOutputMs(segments: PreviewSegment[], sourceMs: number): number {
  if (segments.length === 0) return sourceMs;
  for (const s of segments) {
    if (s.kind === 'source' && sourceMs >= s.fromMs && sourceMs < s.toMs) {
      return s.outMs + (sourceMs - s.fromMs);
    }
    if (s.kind === 'card' && sourceMs >= s.fromMs && sourceMs < s.fromMs + s.durationMs) {
      return s.outMs;
    }
  }
  // Removed-region or past-the-end positions: the next kept point, else end.
  for (const s of segments) {
    if (sourceMs < s.fromMs) return s.outMs;
  }
  return previewDurationMs(segments);
}

/** Output ms -> source ms. Seeking into a card's span lands on its insertion point. */
export function toSourceMs(segments: PreviewSegment[], outMs: number): number {
  if (segments.length === 0) return outMs;
  for (const s of segments) {
    if (outMs >= s.outMs && outMs < s.outMs + s.durationMs) {
      // Source segments carry their offset within the segment; a card span
      // maps back to its insertion point. (Returning bare fromMs here made
      // every seek jump to the segment start.)
      return s.kind === 'card' ? s.fromMs : s.fromMs + (outMs - s.outMs);
    }
  }
  const last = segments[segments.length - 1];
  return outMs <= segments[0].outMs ? segments[0].fromMs : last.toMs;
}

/** The segment containing an output-timeline position, if any. */
export function segmentAtOutput(segments: PreviewSegment[], outMs: number): PreviewSegment | null {
  for (const s of segments) {
    if (outMs >= s.outMs && outMs < s.outMs + s.durationMs) return s;
  }
  return null;
}
