'use client';

import { useEffect, useState } from 'react';
import { X, Download, FileVideo, Lock, Eye, EyeOff } from 'lucide-react';

interface DownloadSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onDownload: (settings: DownloadSettings) => void;
    videoBlob: Blob | null;
    /** True when trims/cuts/title cards are applied to this recording. */
    hasEdits?: boolean;
    /** Duration of the edited recording in ms (for the source picker). */
    editedDurationMs?: number;
    /** Approximate size of the edited recording in bytes. */
    editedSizeBytes?: number;
    /** Duration of the original recording in ms. */
    originalDurationMs?: number;
}

export interface DownloadSettings {
    name: string;
    format: 'webm' | 'mp4';
    /** Password used for HTTP Basic Auth on the MP4 transcode endpoint. */
    password: string;
    /** Which recording to save: the edited version or the untouched original. */
    source: 'edited' | 'original';
}

export const API_PASSWORD_STORAGE_KEY = 'screenrec-api-password';

export default function DownloadSettingsModal({
    isOpen,
    onClose,
    onDownload,
    videoBlob,
    hasEdits = false,
    editedDurationMs = 0,
    editedSizeBytes = 0,
    originalDurationMs = 0
}: DownloadSettingsModalProps) {
    const [name, setName] = useState('Recording');
    const [format, setFormat] = useState<'webm' | 'mp4'>('webm');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [source, setSource] = useState<'edited' | 'original'>('edited');

    // Refresh the default filename and password every time the dialog opens,
    // so each recording gets a current timestamp and a stale name never sticks.
    useEffect(() => {
        if (isOpen) {
            setPassword(sessionStorage.getItem(API_PASSWORD_STORAGE_KEY) || '');
            const now = new Date();
            const pad = (n: number) => String(n).padStart(2, '0');
            const date = `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()}`;
            const hour12 = now.getHours() % 12 || 12;
            const time = `${pad(hour12)}:${pad(now.getMinutes())} ${now.getHours() >= 12 ? 'PM' : 'AM'}`;
            setName(`Recording ${date} ${time}`);
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleDownload = () => {
        if (format === 'mp4') {
            sessionStorage.setItem(API_PASSWORD_STORAGE_KEY, password);
        }
        onDownload({ name, format, password, source: hasEdits ? source : 'original' });
    };

    const fmtDuration = (ms: number) => {
        const total = Math.round(ms / 1000);
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    };

    const formatFileSize = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-gray-800 rounded-2xl shadow-2xl w-full max-w-md p-6 mx-4 animate-fade-in border border-gray-700">
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-indigo-900/60 flex items-center justify-center">
                            <FileVideo size={20} className="text-indigo-400" />
                        </div>
                        <div>
                            <h2 className="text-xl font-semibold text-gray-100">Save Recording</h2>
                            {videoBlob && (
                                <p className="text-sm text-gray-400">{formatFileSize(videoBlob.size)}</p>
                            )}
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-gray-700 rounded-lg transition"
                        aria-label="Close"
                    >
                        <X size={20} className="text-gray-400" />
                    </button>
                </div>

                {hasEdits && (
                    <div className="mb-5">
                        <label className="block text-sm font-medium text-gray-300 mb-2">
                            What to save
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                            <button
                                onClick={() => setSource('edited')}
                                className={`px-4 py-3 rounded-xl border-2 font-medium transition ${source === 'edited'
                                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                                    : 'border-gray-700 hover:border-gray-600 text-gray-300'
                                    }`}
                                data-testid="source-edited"
                            >
                                <span className="block text-sm">Edited</span>
                                <span className="block text-xs text-gray-400 mt-1">
                                    {fmtDuration(editedDurationMs)} · ≈{formatFileSize(editedSizeBytes)}
                                </span>
                            </button>
                            <button
                                onClick={() => setSource('original')}
                                className={`px-4 py-3 rounded-xl border-2 font-medium transition ${source === 'original'
                                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                                    : 'border-gray-700 hover:border-gray-600 text-gray-300'
                                    }`}
                                data-testid="source-original"
                            >
                                <span className="block text-sm">Original</span>
                                <span className="block text-xs text-gray-400 mt-1">
                                    {fmtDuration(originalDurationMs)} · {videoBlob ? formatFileSize(videoBlob.size) : ''}
                                </span>
                            </button>
                        </div>
                        <p className="mt-1.5 text-xs text-gray-500">
                            Your original recording is always kept intact — edits are applied to a copy on save.
                        </p>
                    </div>
                )}

                <div className="mb-5">
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                        File Name
                    </label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full px-4 py-3 rounded-xl bg-gray-900 border border-gray-700 text-gray-100 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 outline-none transition"
                        placeholder="My Recording"
                    />
                    <p className="mt-1.5 text-xs text-gray-500">
                        Spaces and invalid filename characters are converted to _.
                    </p>
                </div>

                <div className="mb-5">
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                        Format
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                        <button
                            onClick={() => setFormat('webm')}
                            className={`px-4 py-3 rounded-xl border-2 font-medium transition ${format === 'webm'
                                ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                                : 'border-gray-700 hover:border-gray-600 text-gray-300'
                                }`}
                        >
                            <span className="block text-sm">WebM</span>
                            <span className="block text-xs text-gray-400 mt-1">Instant download</span>
                        </button>
                        <button
                            onClick={() => setFormat('mp4')}
                            className={`px-4 py-3 rounded-xl border-2 font-medium transition ${format === 'mp4'
                                ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                                : 'border-gray-700 hover:border-gray-600 text-gray-300'
                                }`}
                        >
                            <span className="block text-sm">MP4</span>
                            <span className="block text-xs text-gray-400 mt-1">Server-converted</span>
                        </button>
                    </div>
                </div>

                {format === 'mp4' && (
                    <div className="mb-5">
                        <label className="flex items-center gap-1.5 text-sm font-medium text-gray-300 mb-2">
                            <Lock size={13} /> Transcode password
                        </label>
                        <div className="relative">
                            <input
                                type={showPassword ? 'text' : 'password'}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full px-4 py-3 pr-12 rounded-xl bg-gray-900 border border-gray-700 text-gray-100 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 outline-none transition"
                                placeholder="Encode Password"
                                autoComplete="off"
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword((v) => !v)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-200 transition"
                                aria-label={showPassword ? 'Hide password' : 'Show password'}
                                aria-pressed={showPassword}
                                title={showPassword ? 'Hide password' : 'Show password'}
                                data-testid="password-toggle"
                            >
                                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                            </button>
                        </div>
                        <p className="mt-1.5 text-xs text-gray-500">
                            MP4 conversion runs on the server and requires the API password.
                            A wrong password is rejected — your recording stays available to retry.
                        </p>
                    </div>
                )}

                <div className="flex gap-3">
                    <button
                        onClick={onClose}
                        className="flex-1 px-4 py-3 rounded-xl border border-gray-700 text-gray-300 font-medium hover:bg-gray-700 transition"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleDownload}
                        className="flex-1 px-4 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-medium transition flex items-center justify-center gap-2"
                    >
                        <Download size={18} />
                        Download
                    </button>
                </div>
            </div>
        </div>
    );
}
