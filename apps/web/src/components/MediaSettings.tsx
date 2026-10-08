'use client';

import { Camera, Mic, Sparkles, Wand2 } from 'lucide-react';
import { RESOLUTION_OPTIONS, ResolutionPreset } from '@/config/recording';
import { DeviceOption } from '@/hooks/useDeviceList';
import AudioLevelMeter from './AudioLevelMeter';
import StorageIndicator from './StorageIndicator';
import { StorageBackend, StorageMode } from '@/utils/recordingStorage';

export interface MediaSettingsProps {
    cameras: DeviceOption[];
    microphones: DeviceOption[];
    selectedCameraId: string;
    selectedMicId: string;
    onCameraChange: (deviceId: string) => void;
    onMicChange: (deviceId: string) => void;
    resolution: ResolutionPreset;
    onResolutionChange: (preset: ResolutionPreset) => void;
    sourceSize: { width: number; height: number } | null;
    outputSize: { width: number; height: number } | null;
    micLevel: number;
    micPeak: number;
    isMicOn: boolean;
    /** Captured tab/system audio level (screen capture with audio). */
    systemLevel: number;
    systemPeak: number;
    hasSystemAudio: boolean;
    /** Native background blur (OS-side). null = capability not available. */
    backgroundBlur: boolean | null;
    onToggleBackgroundBlur: () => void;
    /** Native segmentation-mask green screen. null = capability not available. */
    greenScreen: boolean | null;
    onToggleGreenScreen: () => void;
    greenScreenColor: string;
    onGreenScreenColorChange: (color: string) => void;
    /** Preferred storage backend for the next recording. */
    storageMode: StorageMode;
    /** Backend actually used by the current/last recording. */
    storageBackend: StorageBackend | null;
    /** True only when disk was forced and the recording actually fell back to RAM. */
    storageDegraded: boolean;
    /** Camera preview mirroring (self-view). Recorded output is never mirrored. */
    mirrorPreview: boolean;
    onToggleMirrorPreview: () => void;
    isCameraOn: boolean;
    onStorageModeChange: (mode: StorageMode) => void;
    disabled: boolean;
}

const GREEN_SCREEN_COLORS = ['#00b140', '#1e3a8a', '#7c3aed', '#0f766e', '#7f1d1d', '#111827'];

const selectClasses =
    'w-full bg-gray-900 border border-gray-700 text-gray-100 text-sm rounded-lg px-3 py-2 outline-none focus:border-indigo-500 transition';

export default function MediaSettings({
    cameras,
    microphones,
    selectedCameraId,
    selectedMicId,
    onCameraChange,
    onMicChange,
    resolution,
    onResolutionChange,
    sourceSize,
    outputSize,
    micLevel,
    micPeak,
    isMicOn,
    systemLevel,
    systemPeak,
    hasSystemAudio,
    backgroundBlur,
    onToggleBackgroundBlur,
    greenScreen,
    onToggleGreenScreen,
    greenScreenColor,
    onGreenScreenColorChange,
    storageMode,
    storageBackend,
    storageDegraded,
    onStorageModeChange,
    mirrorPreview,
    onToggleMirrorPreview,
    isCameraOn,
    disabled,
}: MediaSettingsProps) {
    return (
        <div className="w-full bg-gray-800 border border-gray-700 rounded-xl p-3 sm:p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                {/* Camera */}
                <div>
                    <label htmlFor="camera-select" className="flex items-center gap-1.5 text-xs font-medium text-gray-300 mb-1.5">
                        <Camera size={13} /> Camera
                    </label>
                    <select
                        id="camera-select"
                        value={selectedCameraId}
                        onChange={(e) => onCameraChange(e.target.value)}
                        disabled={disabled}
                        className={selectClasses}
                    >
                        <option value="">System default</option>
                        {cameras.map((device, i) => (
                            <option key={device.deviceId || `cam-${i}`} value={device.deviceId}>
                                {device.label}
                            </option>
                        ))}
                    </select>
                </div>

                {/* Microphone + level meter */}
                <div>
                    <label htmlFor="mic-select" className="flex items-center gap-1.5 text-xs font-medium text-gray-300 mb-1.5">
                        <Mic size={13} /> Microphone
                    </label>
                    <select
                        id="mic-select"
                        value={selectedMicId}
                        onChange={(e) => onMicChange(e.target.value)}
                        disabled={disabled}
                        className={selectClasses}
                    >
                        <option value="">System default</option>
                        {microphones.map((device, i) => (
                            <option key={device.deviceId || `mic-${i}`} value={device.deviceId}>
                                {device.label}
                            </option>
                        ))}
                    </select>
                    <div className="mt-2 space-y-1.5">
                        <div className="flex items-center gap-2" title="Microphone input level — the bar stays flat when the mic is live but silent">
                            <span className="text-[11px] text-gray-400 w-7 shrink-0">Mic:</span>
                            {isMicOn ? (
                                <AudioLevelMeter level={micLevel} peak={micPeak} />
                            ) : (
                                <span className="text-[11px] text-gray-500">off</span>
                            )}
                        </div>
                        <div className="flex items-center gap-2" title="Tab/system audio — only present when the capture includes audio (tab capture); window capture has none">
                            <span className="text-[11px] text-gray-400 w-7 shrink-0">Tab:</span>
                            {hasSystemAudio ? (
                                <AudioLevelMeter level={systemLevel} peak={systemPeak} />
                            ) : (
                                <span className="text-[11px] text-gray-500">off</span>
                            )}
                        </div>
                    </div>
                </div>

                {/* Resolution */}
                <div>
                    <label htmlFor="resolution-select" className="flex items-center gap-1.5 text-xs font-medium text-gray-300 mb-1.5">
                        <Sparkles size={13} /> Output resolution
                    </label>
                    <select
                        id="resolution-select"
                        value={resolution}
                        onChange={(e) => onResolutionChange(e.target.value as ResolutionPreset)}
                        disabled={disabled}
                        className={selectClasses}
                    >
                        {RESOLUTION_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                    <p className="mt-2 text-[11px] text-gray-400 tabular-nums" aria-live="polite">
                        {sourceSize
                            ? `Source ${sourceSize.width}×${sourceSize.height}`
                            : 'No source active'}
                        {outputSize && sourceSize
                            ? ` → Output ${outputSize.width}×${outputSize.height}`
                            : outputSize
                                ? ` · Output ${outputSize.width}×${outputSize.height}`
                                : ''}
                    </p>
                </div>

                {/* Camera effects */}
                <div>
                    <span className="flex items-center gap-1.5 text-xs font-medium text-gray-300 mb-1.5">
                        <Wand2 size={13} /> Camera effects
                    </span>
                    <div className="flex flex-col gap-1.5">
                        <div className="grid grid-cols-2 gap-1.5">
                            <button
                                type="button"
                                onClick={onToggleBackgroundBlur}
                                disabled={disabled || backgroundBlur === null}
                                title={
                                    backgroundBlur === null
                                        ? 'Unavailable — needs OS camera effects + the Experimental Web Platform features flag (see README → Native background effects)'
                                        : undefined
                                }
                                className={`px-3 py-1.5 text-xs rounded-lg border transition ${backgroundBlur === true
                                    ? 'bg-indigo-600 border-indigo-500 text-white'
                                    : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500'
                                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                                data-testid="blur-toggle"
                            >
                                Blur{backgroundBlur === null ? '' : backgroundBlur ? ' on' : ' off'}
                            </button>
                            <button
                                type="button"
                                onClick={onToggleGreenScreen}
                                disabled={disabled || greenScreen === null}
                                title={
                                    greenScreen === null
                                        ? 'Unavailable — needs OS camera effects + the Experimental Web Platform features flag (see README → Native background effects)'
                                        : undefined
                                }
                                className={`px-3 py-1.5 text-xs rounded-lg border transition ${greenScreen === true
                                    ? 'bg-indigo-600 border-indigo-500 text-white'
                                    : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500'
                                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                                data-testid="green-screen-toggle"
                            >
                                Green screen{greenScreen === null ? '' : greenScreen ? ' on' : ' off'}
                            </button>
                    </div>
                        <button
                            type="button"
                            onClick={onToggleMirrorPreview}
                            disabled={disabled || !isCameraOn}
                            title={
                                !isCameraOn
                                    ? 'Turn the camera on to change preview mirroring'
                                    : 'Flips the live preview only — the recorded output is never mirrored'
                            }
                            className={`px-3 py-1.5 text-xs rounded-lg border transition ${mirrorPreview
                                ? 'bg-indigo-600 border-indigo-500 text-white'
                                : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500'
                                } disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                            Mirror {mirrorPreview ? 'on' : 'off'}
                        </button>
                        {greenScreen === true && (
                            <div className="flex items-center gap-1.5">
                                {GREEN_SCREEN_COLORS.map((color) => (
                                    <button
                                        key={color}
                                        type="button"
                                        aria-label={`Green screen background ${color}`}
                                        onClick={() => onGreenScreenColorChange(color)}
                                        className={`w-5 h-5 rounded-full border-2 transition ${greenScreenColor === color ? 'border-white' : 'border-transparent'
                                            }`}
                                        style={{ backgroundColor: color }}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
            {/* Recording storage: live backend readout + Auto/Disk/RAM test toggle */}
            <div className="mt-3 pt-3 border-t border-gray-700 flex items-center gap-2">
                <span className="text-xs font-medium text-gray-300">Recording storage</span>
                <StorageIndicator
                    mode={storageMode}
                    backend={storageBackend}
                    degraded={storageDegraded}
                    onModeChange={onStorageModeChange}
                />
            </div>
        </div>
    );
}
