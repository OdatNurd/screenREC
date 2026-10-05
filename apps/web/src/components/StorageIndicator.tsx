'use client';

import { HardDrive, MemoryStick } from 'lucide-react';
import { StorageBackend, StorageMode } from '@/utils/recordingStorage';

interface StorageIndicatorProps {
    /** Where the next recording will try to store its chunks. */
    mode: StorageMode;
    /** Backend actually used by the current/last recording (null = nothing recorded yet). */
    backend: StorageBackend | null;
    /** True only when disk was forced and the recording actually fell back to RAM. */
    degraded?: boolean;
    /** Omit for a read-only badge (e.g. the playback bar). */
    onModeChange?: (mode: StorageMode) => void;
    /**
     * 'live'   — describes an active/next recording ("Spooling to disk").
     * 'stored' — describes a finished recording ("Stored on disk").
     */
    phase?: 'live' | 'stored';
    /** Small variant for dense rows. */
    compact?: boolean;
}

const MODE_CYCLE: Record<StorageMode, StorageMode> = {
    auto: 'opfs',
    opfs: 'memory',
    memory: 'auto',
};

const MODE_LABELS: Record<StorageMode, string> = {
    auto: 'Storage: automatic',
    opfs: 'Storage: disk (forced)',
    memory: 'Storage: RAM (forced)',
};

function describe(
    backend: StorageBackend | null,
    mode: StorageMode,
    degraded: boolean,
    phase: 'live' | 'stored'
): { Icon: typeof HardDrive; text: string } {
    if (phase === 'stored') {
        // A finished recording: past tense, and the mode is irrelevant.
        if (backend === 'opfs') return { Icon: HardDrive, text: 'Stored on disk' };
        return {
            Icon: MemoryStick,
            text: degraded ? 'Stored in memory — disk unavailable' : 'Stored in memory',
        };
    }
    // The badge always reports what actually happened, never what was hoped for,
    // and shows the forced mode as a suffix so cycling the toggle gives instant
    // feedback even before the next recording runs.
    const forced = mode === 'opfs' ? ' · forced disk' : mode === 'memory' ? ' · forced RAM' : '';
    if (backend === 'opfs') {
        return { Icon: HardDrive, text: `Spooling to disk${forced}` };
    }
    if (backend === 'memory') {
        if (degraded) {
            // Honest degradation: disk was requested but RAM is in use.
            return { Icon: MemoryStick, text: 'Kept in RAM — disk unavailable' };
        }
        return { Icon: MemoryStick, text: `Recording kept in RAM${forced}` };
    }
    return {
        Icon: mode === 'memory' ? MemoryStick : HardDrive,
        text: MODE_LABELS[mode],
    };
}

export default function StorageIndicator({ mode, backend, degraded = false, phase = 'live', onModeChange, compact }: StorageIndicatorProps) {
    const { Icon, text } = describe(backend, mode, degraded, phase);
    const tooltip =
        'Recordings are spooled to disk (OPFS) when available, keeping RAM flat; otherwise kept in RAM. ' +
        (onModeChange ? 'Click to cycle Auto → Disk → RAM (applies to the next recording).' : '');

    const content = (
        <>
            <Icon size={compact ? 11 : 13} />
            <span>{text}</span>
        </>
    );

    const classes = compact
        ? 'inline-flex items-center gap-1 px-2 py-0.5 bg-gray-700 rounded text-[10px] text-gray-300 font-medium whitespace-nowrap'
        : 'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-gray-700 bg-gray-900 text-gray-300 hover:border-gray-500 transition disabled:opacity-50 disabled:cursor-not-allowed';

    if (!onModeChange) {
        return (
            <span className={classes} title={tooltip}>
                {content}
            </span>
        );
    }

    return (
        <button
            type="button"
            onClick={() => onModeChange(MODE_CYCLE[mode])}
            className={classes}
            title={tooltip}
            aria-label={`Recording storage: ${text}. Click to change storage mode.`}
        >
            {content}
        </button>
    );
}
