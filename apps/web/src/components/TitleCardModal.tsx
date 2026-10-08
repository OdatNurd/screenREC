'use client';

/**
 * Modal for creating an interstitial title card: captures the frame at the
 * insertion point, previews the styled text panel over it, and lets the panel
 * be dragged/resized like the camera overlay. The renderer freezes the frame
 * for the card's duration with the text burned in.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Type } from 'lucide-react';
import type { IndexedRecording, TitleCardSpec } from '@/utils/webmEdit';
import { drawTitleCard, grabFrame } from '@/utils/webmEdit';

interface TitleCardModalProps {
  index: IndexedRecording;
  atMs: number;
  onConfirm: (spec: Omit<TitleCardSpec, 'id'>) => void;
  onClose: () => void;
}

const DURATIONS = [3000, 5000, 8000, 10000];

export default function TitleCardModal({ index, atMs, onConfirm, onClose }: TitleCardModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<VideoFrame | null>(null);
  const [text, setText] = useState('Step 1 — describe this step');
  const [durationMs, setDurationMs] = useState(5000);
  const [fontSizePct, setFontSizePct] = useState(0.05);
  const [box, setBox] = useState({ x: 0.15, y: 0.62, w: 0.7, h: 0.22 });
  const [frameError, setFrameError] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  // Bumped by the Retry button to re-run a failed frame capture.
  const [captureAttempt, setCaptureAttempt] = useState(0);

  // Capture the frame at the insertion point once per attempt.
  useEffect(() => {
    let cancelled = false;
    setFrameReady(false);
    setFrameError(null);
    grabFrame(index, atMs)
      .then((frame) => {
        if (cancelled) { frame.close(); return; }
        frameRef.current = frame;
        setFrameReady(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setFrameError(e instanceof Error ? e.message : 'Could not capture frame');
      });
    return () => {
      cancelled = true;
      frameRef.current?.close();
      frameRef.current = null;
    };
  }, [index, atMs, captureAttempt]);

  // Redraw the preview whenever anything changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) return;
    const v = index.video;
    if (!v) return;
    canvas.width = v.width;
    canvas.height = v.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const previewSpec: TitleCardSpec = {
      id: 'preview',
      atMs,
      durationMs,
      text,
      fontSizePct,
      textColor: '#f9fafb',
      bgColor: 'rgba(17, 24, 39, 0.85)',
      box,
    };
    drawTitleCard(ctx, frame, previewSpec, v.width, v.height);
  }, [frameReady, text, durationMs, fontSizePct, box, index, atMs]);

  const timeFromEvent = useCallback((e: React.MouseEvent | MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  }, []);

  const onBoxMouseDown = (e: React.MouseEvent, mode: 'move' | 'resize') => {
    e.preventDefault();
    e.stopPropagation();
    const start = timeFromEvent(e);
    const startBox = { ...box };

    const onMove = (ev: MouseEvent) => {
      const p = timeFromEvent(ev);
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (mode === 'move') {
        setBox({
          ...startBox,
          x: Math.max(0, Math.min(1 - startBox.w, startBox.x + dx)),
          y: Math.max(0, Math.min(1 - startBox.h, startBox.y + dy)),
        });
      } else {
        setBox({
          ...startBox,
          w: Math.max(0.15, Math.min(1 - startBox.x, startBox.w + dx)),
          h: Math.max(0.1, Math.min(1 - startBox.y, startBox.h + dy)),
        });
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-800 rounded-2xl shadow-2xl w-full max-w-2xl p-6 mx-4 border border-gray-700" data-testid="title-card-modal">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-900/60 flex items-center justify-center">
              <Type size={20} className="text-emerald-400" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-100">Insert title card</h2>
              <p className="text-sm text-gray-400">Freezes this moment with your text over it</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-700 rounded-lg transition" aria-label="Close">
            <X size={20} className="text-gray-400" />
          </button>
        </div>

        {/* Preview: captured frame + draggable text box */}
        <div className="relative rounded-xl overflow-hidden border border-gray-700 bg-black">
          {frameError ? (
            <div className="w-full aspect-video flex flex-col items-center justify-center gap-3 px-8">
              <p className="text-sm text-red-400 text-center" data-testid="card-frame-error">{frameError}</p>
              <button
                onClick={() => setCaptureAttempt((n) => n + 1)}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-100 rounded-lg text-sm font-medium transition"
                data-testid="card-frame-retry"
              >
                Retry frame capture
              </button>
            </div>
          ) : (
            <div className="relative">
              <canvas ref={canvasRef} className="w-full aspect-video" />
              {/* Interactive box overlay in normalized coordinates */}
              <div
                className="absolute border-2 border-emerald-400/80 cursor-move rounded"
                style={{
                  left: `${box.x * 100}%`,
                  top: `${box.y * 100}%`,
                  width: `${box.w * 100}%`,
                  height: `${box.h * 100}%`,
                }}
                onMouseDown={(e) => onBoxMouseDown(e, 'move')}
                data-testid="card-box"
              >
                <div
                  className="absolute -right-1.5 -bottom-1.5 w-3 h-3 bg-emerald-400 rounded-sm cursor-nwse-resize"
                  onMouseDown={(e) => onBoxMouseDown(e, 'resize')}
                  data-testid="card-box-resize"
                />
              </div>
              {!frameReady && !frameError && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                  <div className="w-8 h-8 border-4 border-white/30 border-t-white rounded-full animate-spin" />
                </div>
              )}
            </div>
          )}
        </div>
        <p className="mt-1.5 text-xs text-gray-500">Drag the green box to position the text panel.</p>

        {/* Text */}
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-300 mb-2">Text</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            className="w-full px-4 py-3 rounded-xl bg-gray-900 border border-gray-700 text-gray-100 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/30 outline-none transition resize-none"
            placeholder="Step 1 — describe this step"
            data-testid="card-text"
          />
        </div>

        {/* Duration + size */}
        <div className="mt-4 flex flex-wrap items-center gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Duration</label>
            <div className="flex gap-2">
              {DURATIONS.map((d) => (
                <button
                  key={d}
                  onClick={() => setDurationMs(d)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${durationMs === d
                    ? 'bg-emerald-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                >
                  {d / 1000}s
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Text size: {Math.round(fontSizePct * 100)}%
            </label>
            <input
              type="range"
              min={2}
              max={10}
              value={Math.round(fontSizePct * 100)}
              onChange={(e) => setFontSizePct(Number(e.target.value) / 100)}
              className="w-full accent-emerald-500"
              data-testid="card-font-size"
            />
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-3 rounded-xl border border-gray-700 text-gray-300 font-medium hover:bg-gray-700 transition"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm({ atMs, durationMs, text, fontSizePct, textColor: '#f9fafb', bgColor: 'rgba(17, 24, 39, 0.85)', box })}
            disabled={!text.trim()}
            className="flex-1 px-4 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition disabled:opacity-40"
            data-testid="card-confirm"
          >
            Insert card ({durationMs / 1000}s)
          </button>
        </div>
      </div>
    </div>
  );
}
