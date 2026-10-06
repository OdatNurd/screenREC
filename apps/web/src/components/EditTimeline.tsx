'use client';

/**
 * Timeline strip for editing a finished recording: head/tail trim handles,
 * interior cut regions, title-card markers, keyframe ticks, and a snap
 * toggle. Handles snap to real keyframes (parsed from the file) in snap mode;
 * with snap off they move freely and cuts are frame-accurate at render time.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Scissors,
  Trash2,
  Type,
  Undo2,
  Redo2,
  X,
} from 'lucide-react';
import type { EdlState, IndexedRecording } from '@/utils/webmEdit';

interface EditTimelineProps {
  index: IndexedRecording;
  edl: EdlState;
  playheadMs: number;
  canUndo: boolean;
  canRedo: boolean;
  onChange: (edl: EdlState) => void;
  onSeek: (ms: number) => void;
  onAddCard: (atMs: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onDone: () => void;
}

interface DragState {
  kind: 'trimStart' | 'trimEnd' | 'cutStart' | 'cutEnd';
  cutId?: string;
}

function fmt(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = (total % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
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
  onUndo,
  onRedo,
  onDone,
}: EditTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<{ startMs: number; endMs: number } | null>(null);
  const [dragHint, setDragHint] = useState<{ ms: number; snapped: boolean } | null>(null);
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
  }, [edl, durationMs, onChange, resolveTime]);

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

  const startDrag = (e: React.MouseEvent, state: DragState) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = state;
    setDrag(state);
    applyDrag(state, timeAtClientX(e.clientX));
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
              className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center"
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
              className="absolute top-0 bottom-0 bg-emerald-400/40 border-x border-emerald-300"
              style={{ left: `${leftPct}%`, width: `${Math.max(2, widthPct)}%` }}
              title={`Title card "${card.text}"`}
              data-testid="card-marker"
            >
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); removeCard(card.id); }}
                className="absolute -top-2 -right-2 w-5 h-5 bg-emerald-500 hover:bg-emerald-400 rounded-full flex items-center justify-center"
                title="Remove title card"
              >
                <X size={11} className="text-white" />
              </button>
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
        />

        {/* Drag badge */}
        {dragHint && (
          <div
            className="absolute -top-8 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-[10px] text-gray-200 whitespace-nowrap z-30 pointer-events-none"
            style={{ left: pct(dragHint.ms), transform: 'translateX(-50%)' }}
          >
            {dragHint.snapped ? `Snapped to keyframe · ${fmt(dragHint.ms)}` : `Frame-accurate · ${fmt(dragHint.ms)}`}
          </div>
        )}
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
