/**
 * Types for the pure-TS WebM editing engine.
 *
 * The engine performs container-level surgery on MediaRecorder WebM output:
 * it copies encoded blocks verbatim (lossless) or replaces small regions via
 * WebCodecs (frame-accurate joins, title cards). No wasm, no re-encode of
 * untouched footage.
 */

/** Video track metadata extracted while indexing. */
export interface VideoTrackInfo {
  trackNumber: number;
  /** Matroska CodecID, e.g. 'V_VP8' / 'V_VP9'. */
  codecId: string;
  /** WebCodecs codec string ('vp8' / 'vp09.00.10.08' / ...). */
  codec: string;
  width: number;
  height: number;
  /** CodecPrivate element bytes (VP9 vpcC), when present. */
  codecPrivate?: Uint8Array;
}

/** Audio track metadata extracted while indexing. */
export interface AudioTrackInfo {
  trackNumber: number;
  codecId: string;
  codec: string;
  sampleRate: number;
  channels: number;
  codecPrivate?: Uint8Array;
}

/** A reference to one encoded media block (SimpleBlock or Block) in the source. */
export interface BlockRef {
  /** Absolute timestamp in milliseconds. */
  timeMs: number;
  trackNumber: number;
  isKeyframe: boolean;
  /**
   * Byte offset of the block body inside the source blob. The body starts at
   * the track-number VINT, followed by the int16 relative timecode and flags.
   */
  bodyOffset: number;
  /** Total body size in bytes (track VINT + timecode + flags + frame data). */
  bodySize: number;
  /** Length of the track-number VINT at the start of the body. */
  trackVintLen: number;
}

/** Result of indexing a recording: keyframe map + block directory + tracks. */
export interface IndexedRecording {
  blob: Blob;
  /** TimecodeScale in nanoseconds (1_000_000 = millisecond timecodes). */
  timecodeScaleNs: number;
  /** Duration in ms derived from the last block timestamp. */
  durationMs: number;
  video: VideoTrackInfo | null;
  audio: AudioTrackInfo | null;
  /** Timestamps of video keyframes in ms (sorted). */
  keyframesMs: number[];
  /** All blocks sorted by timestamp (stable). */
  blocks: BlockRef[];
  /** Raw byte range of the source Tracks element, copied verbatim on output. */
  tracksStart: number;
  tracksEnd: number;
}

/** A removed interior region (both bounds in source milliseconds). */
export interface CutRegion {
  id: string;
  startMs: number;
  endMs: number;
}

/** A generated interstitial title card. */
export interface TitleCardSpec {
  id: string;
  /** Source timestamp (ms) where the card is inserted. */
  atMs: number;
  /** How long the card stays on screen, in ms. */
  durationMs: number;
  text: string;
  /** Font size as a fraction of frame height (0.02 – 0.12). */
  fontSizePct: number;
  textColor: string;
  /** Panel background (CSS color, alpha allowed). */
  bgColor: string;
  /** Text panel position/size, normalized 0..1 against the frame. */
  box: { x: number; y: number; w: number; h: number };
}

/** The edit decision list the UI produces and the renderer consumes. */
export interface EdlState {
  trimStartMs: number;
  trimEndMs: number;
  cuts: CutRegion[];
  cards: TitleCardSpec[];
  /**
   * When true, kept segments start on keyframes (snapped by the UI/renderer)
   * and are copied losslessly. When false, segment starts may fall mid-GOP and
   * the sub-GOP at each such start is re-encoded via WebCodecs so cuts land
   * exactly where the user placed them.
   */
  snapToKeyframes: boolean;
}

/** A synthetic encoded block produced by WebCodecs (re-encode patch / title card). */
export interface GeneratedBlock {
  /** Timestamp relative to the start of the generated segment, in ms. */
  timeMs: number;
  trackNumber: number;
  isKeyframe: boolean;
  data: Uint8Array;
}

/** A video keyframe interval record used for sub-GOP re-encodes. */
export interface GopRange {
  /** Keyframe at or before `fromMs`. */
  gopStartMs: number;
  /** First keyframe after `gopStartMs`, or Infinity at end of file. */
  nextKeyframeMs: number;
}
