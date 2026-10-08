'use client';

/**
 * Timeline strip for editing a finished recording: head/tail trim handles,
 * interior cut regions, title-card markers, keyframe ticks, and a snap
 * toggle. Handles snap to real keyframes (parsed from the file) in snap mode;
 * with snap off they move freely and cuts are frame-accurate at render time.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { RECORDING_CONFIG } from '@/config/recording';
import {
  Check,
  Scissors,
  Trash2,
  Type,
  Undo2,
  Redo2,
  X,
} from 'lucide-react';
import { keptRanges } from '@/utils/webmEdit';
import type { EdlState, IndexedRecording, TitleCardSpec } from '@/utils/webmEdit';

interface EditTimelineProps {
  index: IndexedRecording;
  edl: EdlState;
  playheadMs: number;
  canUndo: boolean;
  canRedo: boolean;
  onChange: (edl: EdlState) => void;
  onSeek: (ms: number) => void;
  onAddCard: (atMs: number) => void;
  /** Open the card editor for an already-placed card. */
  onEditCard: (card: TitleCardSpec) => void;
  onUndo: () => void;
  onRedo: () => void;
  onDone: () => void;
  /** Live hold progress (0..1) of the card currently playing in the preview. */
  holdProgress?: { cardId: string; fraction: number } | null;
}

interface DragState {
  kind: 'trimStart' | 'trimEnd' | 'cutStart' | 'cutEnd' | 'cardEnd' | 'cardMove';
  cutId?: string;
  cardId?: string;
  /** For card moves: pointer offset from the card's insertion point. */
  grabOffsetMs?: number;
}

function fmt(ms: number): string {
  // MM:SS:FF at the recording's frame rate (video-editor convention).
  const fps = RECORDING_CONFIG.CANVAS.DEFAULT_FPS;
  const totalFrames = Math.max(0, Math.round((ms / 1000) * fps));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(totalFrames / (fps * 60)))}:${pad(Math.floor(totalFrames / fps) % 60)}:${pad(totalFrames % fps)}`;
}

export default function EditTimeline({
  index,
  edl,
  playheadMs,
  canUndo,
  canRedo,
  onChange,
  onSeek,
  onAddCard,
  onEditCard,
  onUndo,
  onRedo,
  onDone,
  holdProgress,
}: EditTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<{ startMs: number; endMs: number } | null>(null);
  const [dragHint, setDragHint] = useState<{ ms: number; snapped: boolean; label?: string } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const selectionAnchorRef = useRef<number | null>(null);

  const durationMs = index.durationMs;

  const timeAtClientX = useCallback((clientX: number): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return pct * durationMs;
  }, [durationMs]);

  const nearestKeyframe = useCallback((ms: number): number => {
    const kf = index.keyframesMs;
    if (kf.length === 0) return ms;
    let best = kf[0];
    for (const k of kf) {
      if (Math.abs(k - ms) < Math.abs(best - ms)) best = k;
    }
    return best;
  }, [index.keyframesMs]);

  // In snap mode handles magnetically snap to real keyframe positions.
  const resolveTime = useCallback((ms: number): number => {
    return edl.snapToKeyframes ? nearestKeyframe(ms) : ms;
  }, [edl.snapToKeyframes, nearestKeyframe]);

  const applyDrag = useCallback((state: DragState, rawMs: number) => {
    if (state.kind === 'cardEnd' && state.cardId) {
      // A card hold is not a cut point, so its length is free (never
      // keyframe-snapped). It may only span the kept region containing its
      // insertion point — never removed footage or past the recording — and
      // never shrinks below 500 ms (unless the region itself is smaller).
      const card = edl.cards.find((c) => c.id === state.cardId);
      if (!card) return;
      const range = keptRanges(index, edl).find(
        (r) => card.atMs >= r.startMs && card.atMs < r.endMs
      );
      const maxEnd = range ? range.endMs : Math.min(edl.trimEndMs, durationMs);
      const maxDur = Math.max(0, maxEnd - card.atMs);
      const dur = Math.max(Math.min(500, maxDur), Math.min(rawMs - card.atMs, maxDur));
      setDragHint({ ms: rawMs, snapped: false, label: `Card · ${fmt(dur)}` });
      onChange({
        ...edl,
        cards: edl.cards.map((c) => (c.id === card.id ? { ...c, durationMs: dur } : c)),
      });
      return;
    }
    if (state.kind === 'cardMove' && state.cardId) {
      // Sliding the card re-places its insertion point. Snap like every other
      // handle and keep the whole hold inside its kept region.
      const card = edl.cards.find((c) => c.id === state.cardId);
      if (!card) return;
      const range = keptRanges(index, edl).find(
        (r) => card.atMs >= r.startMs && card.atMs < r.endMs
      );
      const lo = range ? range.startMs : edl.trimStartMs;
      const hi = Math.max(lo, (range ? range.endMs : edl.trimEndMs) - card.durationMs);
      const at = Math.max(lo, Math.min(resolveTime(rawMs - (state.grabOffsetMs ?? 0)), hi));
      setDragHint({ ms: at, snapped: edl.snapToKeyframes, label: `Card at ${fmt(at)}` });
      onChange({
        ...edl,
        cards: edl.cards.map((c) => (c.id === card.id ? { ...c, atMs: at } : c)),
      });
      return;
    }
    const ms = resolveTime(rawMs);
    setDragHint({ ms, snapped: edl.snapToKeyframes });

    if (state.kind === 'trimStart') {
      const max = edl.trimEndMs - 200;
      onChange({ ...edl, trimStartMs: Math.max(0, Math.min(ms, max)) });
    } else if (state.kind === 'trimEnd') {
      const min = edl.trimStartMs + 200;
      onChange({ ...edl, trimEndMs: Math.min(durationMs, Math.max(ms, min)) });
    } else if (state.cutId) {
      onChange({
        ...edl,
        cuts: edl.cuts.map((c) => {
          if (c.id !== state.cutId) return c;
          if (state.kind === 'cutStart') {
            return { ...c, startMs: Math.max(edl.trimStartMs, Math.min(ms, c.endMs - 200)) };
          }
          return { ...c, endMs: Math.min(edl.trimEndMs, Math.max(ms, c.startMs + 200)) };
        }),
      });
    }
  }, [edl, index, durationMs, onChange, resolveTime]);

  // Window-level listeners while dragging a handle or selecting a region.
  useEffect(() => {
    if (!drag && !selecting) return;

    const onMove = (e: MouseEvent) => {
      const ms = timeAtClientX(e.clientX);
      if (dragRef.current) {
        applyDrag(dragRef.current, ms);
      } else if (selectionAnchorRef.current !== null) {
        const anchor = selectionAnchorRef.current;
        setSelection({ startMs: Math.min(anchor, ms), endMs: Math.max(anchor, ms) });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      setDrag(null);
      setDragHint(null);
      selectionAnchorRef.current = null;
      setSelecting(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, selecting, applyDrag, timeAtClientX]);

  const startDrag = (e: React.MouseEvent, state: DragState, applyImmediately = true) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = state;
    setDrag(state);
    // Card moves start relative to the grab point; a plain click (no move)
    // must leave the card exactly where it is.
    if (applyImmediately) applyDrag(state, timeAtClientX(e.clientX));
  };

  const onTrackMouseDown = (e: React.MouseEvent) => {
    const ms = timeAtClientX(e.clientX);
    // Click seeks; dragging across the track selects a region to remove.
    selectionAnchorRef.current = ms;
    setSelecting(true);
    setSelection(null);
    onSeek(ms);
  };

  const pct = (ms: number) => `${Math.max(0, Math.min(100, (ms / durationMs) * 100))}%`;

  const addCutFromSelection = () => {
    if (!selection || selection.endMs - selection.startMs < 200) return;
    const id = `cut-${Date.now()}`;
    // In snap mode the new section's bounds land on keyframes like every
    // other handle, so the strip always shows exactly what will be removed.
    const startMs = resolveTime(selection.startMs);
    const endMs = resolveTime(selection.endMs);
    onChange({
      ...edl,
      cuts: [...edl.cuts, {
        id,
        startMs: Math.min(startMs, endMs - 200),
        endMs: Math.max(endMs, startMs + 200),
      }],
    });
    setSelection(null);
  };

  const removeCut = (id: string) => {
    onChange({ ...edl, cuts: edl.cuts.filter((c) => c.id !== id) });
  };

  const removeCard = (id: string) => {
    onChange({ ...edl, cards: edl.cards.filter((c) => c.id !== id) });
  };

  const toggleSnap = () => {
    onChange({ ...edl, snapToKeyframes: !edl.snapToKeyframes });
  };

  // A title card only plays in a kept region — refuse removed/trimmed spots.
  const playheadRemoved =
    playheadMs < edl.trimStartMs ||
    playheadMs >= edl.trimEndMs ||
    edl.cuts.some((c) => playheadMs >= c.startMs && playheadMs < c.endMs);

  return (
    <div className="w-full bg-gray-800 border border-gray-700 rounded-xl p-4" data-testid="edit-timeline">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Scissors size={15} className="text-indigo-400" />
          <h3 className="text-sm font-semibold text-gray-100">Edit recording</h3>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={edl.snapToKeyframes}
            onChange={toggleSnap}
            className="rounded accent-indigo-500 w-3.5 h-3.5"
            data-testid="snap-toggle"
          />
          Snap to keyframes
        </label>
      </div>

      {/* The timeline strip */}
      <div
        ref={trackRef}
        className="relative h-14 rounded-lg bg-gray-900 border border-gray-700 cursor-crosshair select-none"
        onMouseDown={onTrackMouseDown}
        data-testid="edit-track"
      >
        {/* Kept base */}
        <div className="absolute inset-y-0 left-0 right-0 bg-indigo-500/20 rounded-lg" />

        {/* Trimmed-away areas */}
        <div
          className="absolute inset-y-0 left-0 bg-black/60 rounded-l-lg"
          style={{ width: pct(edl.trimStartMs) }}
        />
        <div
          className="absolute inset-y-0 right-0 bg-black/60 rounded-r-lg"
          style={{ width: `${100 - parseFloat(pct(edl.trimEndMs))}%` }}
        />

        {/* Keyframe ticks */}
        {index.keyframesMs.map((k) => (
          <div
            key={`kf-${k}`}
            className="absolute top-0 bottom-0 w-px bg-white/25"
            style={{ left: pct(k) }}
            title={`Keyframe ${fmt(k)}`}
          />
        ))}

        {/* Cut regions */}
        {edl.cuts.map((cut) => (
          <div
            key={cut.id}
            className="absolute inset-y-0 bg-red-500/30 border-x-2 border-red-400"
            style={{ left: pct(cut.startMs), width: pct(cut.endMs - cut.startMs) }}
            data-testid="cut-region"
          >
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); removeCut(cut.id); }}
              className="absolute -top-2 -right-2 z-20 w-5 h-5 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center"
              title="Restore this section"
            >
              <X size={11} className="text-white" />
            </button>
          </div>
        ))}

        {/* Card markers */}
        {edl.cards.map((card) => {
          // The band's width is illustrative (card duration on the source
          // axis) and left + width can exceed the track near the recording's
          // end, spilling outside the box. Clamp: keep the left edge exactly
          // at the insertion point and shrink to fit; only in the degenerate
          // tail case nudge left so the marker stays visible.
          const wPct = parseFloat(pct(Math.max(240, card.durationMs)));
          const atPct = parseFloat(pct(card.atMs));
          const widthPct = Math.min(wPct, 100 - atPct);
          const leftPct = widthPct < 2 ? Math.min(atPct, 98) : atPct;
          return (
            <div
              key={card.id}
              className="absolute top-0 bottom-0 bg-emerald-400/40 border-x border-emerald-300 cursor-grab active:cursor-grabbing"
              style={{ left: `${leftPct}%`, width: `${Math.max(2, widthPct)}%` }}
              title={`Title card "${card.text}" · ${fmt(card.durationMs)} — double-click to edit · drag to move · right edge to resize`}
              data-testid="card-marker"
              data-at-ms={card.atMs}
              data-duration-ms={card.durationMs}
              onMouseDown={(e) =>
                startDrag(
                  e,
                  {
                    kind: 'cardMove',
                    cardId: card.id,
                    grabOffsetMs: timeAtClientX(e.clientX) - card.atMs,
                  },
                  false
                )
              }
              onDoubleClick={(e) => { e.stopPropagation(); onEditCard(card); }}
            >
              {holdProgress && holdProgress.cardId === card.id && (
                <div
                  className="absolute inset-y-0 left-0 bg-emerald-200/50 pointer-events-none"
                  style={{ width: `${Math.max(0, Math.min(1, holdProgress.fraction)) * 100}%` }}
                  data-testid="card-hold-fill"
                />
              )}
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); removeCard(card.id); }}
                className="absolute -top-2 -right-2 z-20 w-5 h-5 bg-emerald-500 hover:bg-emerald-400 rounded-full flex items-center justify-center"
                title="Remove title card"
              >
                <X size={11} className="text-white" />
              </button>
              {/* Right-edge handle: lengthen/shorten the hold after placement */}
              <div
                onMouseDown={(e) => startDrag(e, { kind: 'cardEnd', cardId: card.id })}
                className="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize bg-emerald-300/60 hover:bg-emerald-200 z-20"
                title="Hold length"
                data-testid="handle-card-end"
              />
            </div>
          );
        })}

        {/* Live selection */}
        {selection && (
          <div
            className="absolute inset-y-0 bg-indigo-400/40 border-x border-indigo-300"
            style={{ left: pct(selection.startMs), width: pct(selection.endMs - selection.startMs) }}
            data-testid="selection"
          />
        )}

        {/* Trim handles */}
        <div
          className="absolute inset-y-0 w-3 -ml-1.5 bg-indigo-500 rounded cursor-ew-resize hover:bg-indigo-400 z-10"
          style={{ left: pct(edl.trimStartMs) }}
          onMouseDown={(e) => startDrag(e, { kind: 'trimStart' })}
          title="Trim start"
          data-testid="handle-trim-start"
        />
        <div
          className="absolute inset-y-0 w-3 -ml-1.5 bg-indigo-500 rounded cursor-ew-resize hover:bg-indigo-400 z-10"
          style={{ left: pct(edl.trimEndMs) }}
          onMouseDown={(e) => startDrag(e, { kind: 'trimEnd' })}
          title="Trim end"
          data-testid="handle-trim-end"
        />
        {edl.cuts.map((cut) => (
          <div key={`hs-${cut.id}`}>
            <div
              className="absolute inset-y-0 w-2.5 -ml-1.25 bg-red-400 rounded cursor-ew-resize hover:bg-red-300 z-10"
              style={{ left: pct(cut.startMs) }}
              onMouseDown={(e) => startDrag(e, { kind: 'cutStart', cutId: cut.id })}
              title="Section start"
              data-testid="handle-cut-start"
            />
            <div
              className="absolute inset-y-0 w-2.5 -ml-1.25 bg-red-400 rounded cursor-ew-resize hover:bg-red-300 z-10"
              style={{ left: pct(cut.endMs) }}
              onMouseDown={(e) => startDrag(e, { kind: 'cutEnd', cutId: cut.id })}
              title="Section end"
              data-testid="handle-cut-end"
            />
          </div>
        ))}

        {/* Playhead */}
        <div
          className="absolute -top-1 -bottom-1 w-0.5 bg-white shadow z-20 pointer-events-none"
          style={{ left: pct(playheadMs) }}
          data-testid="playhead"
        />

        {/* Drag badge */}
        {dragHint && (
          <div
            className="absolute -top-8 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-[10px] text-gray-200 whitespace-nowrap z-30 pointer-events-none"
            style={{ left: pct(dragHint.ms), transform: 'translateX(-50%)' }}
            data-testid="drag-hint"
          >
            {dragHint.label ?? (dragHint.snapped ? `Snapped to keyframe · ${fmt(dragHint.ms)}` : `Frame-accurate · ${fmt(dragHint.ms)}`)}
          </div>
        )}
      </div>

      {/* In/out readout: exact handle positions and the span between them */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] font-mono tabular-nums text-gray-400" data-testid="trim-readout">
        <span>In <span className="text-gray-100">{fmt(edl.trimStartMs)}</span></span>
        <span>Out <span className="text-gray-100">{fmt(edl.trimEndMs)}</span></span>
        <span>Length <span className="text-gray-100">{fmt(edl.trimEndMs - edl.trimStartMs)}</span></span>
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2 mt-3">
        {selection && selection.endMs - selection.startMs >= 200 && (
          <>
            <button
              onClick={addCutFromSelection}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-medium transition"
              data-testid="remove-section"
            >
              <Trash2 size={12} />
              Remove {fmt(selection.startMs)}–{fmt(selection.endMs)}
            </button>
            <button
              onClick={() => setSelection(null)}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg text-xs font-medium transition"
            >
              Cancel
            </button>
          </>
        )}
        <button
          onClick={() => onAddCard(playheadMs)}
          disabled={playheadRemoved}
          title={playheadRemoved ? 'Pick a spot outside the removed sections first' : undefined}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="add-card"
        >
          <Type size={12} />
          Title card at {fmt(playheadMs)}
        </button>

        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={onUndo}
            disabled={!canUndo}
            className="p-1.5 text-gray-300 hover:text-white hover:bg-gray-700 rounded-lg transition disabled:opacity-30"
            title="Undo"
          >
            <Undo2 size={14} />
          </button>
          <button
            onClick={onRedo}
            disabled={!canRedo}
            className="p-1.5 text-gray-300 hover:text-white hover:bg-gray-700 rounded-lg transition disabled:opacity-30"
            title="Redo"
          >
            <Redo2 size={14} />
          </button>
          <button
            onClick={onDone}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition"
            data-testid="edit-done"
          >
            <Check size={12} />
            Done
          </button>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-gray-500">
        {edl.snapToKeyframes
          ? 'Handles snap to the nearest keyframe (marked on the strip) — what you see is exactly where cuts land. Click the strip to preview a cut point; drag across it to select a section to remove.'
          : 'Snap is off: cuts are frame-accurate — the few frames at each join are re-encoded, everything else is lossless.'}
      </p>
    </div>
  );
}
