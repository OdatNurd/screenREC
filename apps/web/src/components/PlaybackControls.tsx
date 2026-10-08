'use client';

import { Download, RotateCcw, Scissors, Check } from 'lucide-react';
import StorageIndicator from './StorageIndicator';
import { StorageBackend } from '@/utils/recordingStorage';
import { useCallback } from 'react';

interface PlaybackControlsProps {
  onDownload: () => void;
  onNewRecording: () => void;
  videoBlob?: Blob | null;
  recordingName?: string;
  /** Actual recorded video dimensions. */
  resolution?: { width: number; height: number } | null;
  /** Where this recording's bytes were stored while recording. */
  storageBackend?: StorageBackend | null;
  /** True only when disk was forced and the recording actually fell back to RAM. */
  storageDegraded?: boolean;
  /** Enter/leave edit mode for this recording. */
  onEdit?: () => void;
  /** Whether edit mode is currently active. */
  editActive?: boolean;
  /** True while the edit list is being built (Edit button shows a spinner). */
  editBusy?: boolean;
  /** Whether any trims/cuts/cards are currently applied. */
  hasEdits?: boolean;
}

export default function PlaybackControls({
  onDownload,
  onNewRecording,
  videoBlob,
  recordingName,
  resolution,
  storageBackend,
  storageDegraded,
  onEdit,
  editActive,
  editBusy = false,
  hasEdits
}: PlaybackControlsProps) {
  const formatFileSize = useCallback((bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }, []);

  return (
    <div className="w-full bg-gray-800 border border-gray-700 rounded-xl shadow-sm p-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-gray-100 truncate max-w-[250px]">
            {recordingName || 'Recording'}
          </h3>

          {videoBlob && (
            <div className="flex items-center gap-1.5 mt-1">
              <span className="px-2 py-0.5 bg-gray-700 rounded text-[10px] text-gray-300 font-medium">
                {formatFileSize(videoBlob.size)}
              </span>
              <span className="px-2 py-0.5 bg-gray-700 rounded text-[10px] text-gray-300 font-medium">
                {videoBlob.type.split('/')[1]?.split(';')[0]?.toUpperCase() || 'VIDEO'}
              </span>
              {resolution && (
                <span className="px-2 py-0.5 bg-gray-700 rounded text-[10px] text-gray-300 font-medium tabular-nums">
                  {resolution.width}×{resolution.height}
                </span>
              )}
              {storageBackend && (
                <StorageIndicator mode="auto" backend={storageBackend} degraded={storageDegraded} phase="stored" compact />
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          {onEdit && (
            <button
              onClick={onEdit}
              disabled={editBusy}
              data-testid="edit-button"
              className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition disabled:opacity-70 disabled:cursor-wait ${editActive
                ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
                : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                }`}
            >
              {editBusy ? (
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" data-testid="edit-spinner" />
              ) : editActive ? (
                <Check size={14} />
              ) : (
                <Scissors size={14} />
              )}
              {editBusy ? 'Building edit list…' : editActive ? 'Done editing' : 'Edit'}
              {!editActive && !editBusy && hasEdits && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="Edits applied" />
              )}
            </button>
          )}
          <button
            onClick={onNewRecording}
            className="flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg text-sm font-medium transition"
          >
            <RotateCcw size={14} />
            New
          </button>

          <button
            onClick={onDownload}
            className="flex items-center justify-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition shadow-sm"
          >
            <Download size={14} />
            Download
          </button>
        </div>
      </div>
    </div>
  );
}
