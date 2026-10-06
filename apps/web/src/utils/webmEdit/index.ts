/**
 * Pure-TS WebM editing engine: keyframe-aware trim/cut with lossless
 * container surgery, frame-accurate joins and title cards via WebCodecs.
 * No wasm.
 */
export * from './types';
export {
  indexRecording,
  gopAround,
  keyframeAtOrBefore,
  keyframeAtOrAfter,
} from './indexRecording';
export { renderEdl, keptRanges, estimateEditedBytes } from './renderEdl';
export {
  buildPreviewSegments,
  previewDurationMs,
  toOutputMs,
  toSourceMs,
  segmentAtOutput,
} from './preview';
export type { PreviewSegment } from './preview';
export { grabFrame, reencodeSubGop, generateTitleCard, drawTitleCard } from './webcodecs';
