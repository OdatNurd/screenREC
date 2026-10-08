'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Play, Pause, Volume2, VolumeX } from 'lucide-react';
import Image from 'next/image';
import {
    previewDurationMs,
    toOutputMs,
    toSourceMs,
    type PreviewSegment,
} from '@/utils/webmEdit';
import { RECORDING_CONFIG } from '@/config/recording';

const VOLUME_STORAGE_KEY = 'screenrec-playback-volume';

/** WYSIWYG edit preview: playback follows the EDL (skips cuts, holds cards). */
export interface PlayerPreview {
    segments: PreviewSegment[];
    /** Pre-rendered title-card images keyed by card id (data URLs). */
    cardImages: Record<string, string>;
}

interface MinimalVideoPlayerProps {
    src: string;
    onLoadedMetadata?: (duration: number) => void;
    /** Hands the underlying <video> element to the parent (edit timeline seeks). */
    onVideoElement?: (el: HTMLVideoElement | null) => void;
    /** Playhead position for the edit timeline (source ms). */
    onTimeUpdate?: (timeMs: number) => void;
    /**
     * Live title-card hold progress (0..1) while a card is on screen, else
     * null. Lets the timeline show the hold playing out on the card marker.
     */
    onCardProgress?: (hold: { cardId: string; fraction: number } | null) => void;
    /** When set, the player shows edited time and plays back the edited cut. */
    preview?: PlayerPreview | null;
}

export default function MinimalVideoPlayer({ src, onLoadedMetadata, onVideoElement, onTimeUpdate, onCardProgress, preview }: MinimalVideoPlayerProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const progressRef = useRef<HTMLDivElement>(null);

    // The supervision tick below must not restart when a callback identity
    // changes (that would dismiss an in-flight card hold).
    const onTimeUpdateRef = useRef(onTimeUpdate);
    const onCardProgressRef = useRef(onCardProgress);
    useEffect(() => {
        onTimeUpdateRef.current = onTimeUpdate;
        onCardProgressRef.current = onCardProgress;
    });

    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const [isReady, setIsReady] = useState(false);
    // Playback loudness (not mic gain): 0..1, persisted across sessions.
    const [volume, setVolume] = useState(1);

    // Edit-preview state: the card currently held on screen + its elapsed time.
    const [activeCard, setActiveCard] = useState<PreviewSegment | null>(null);
    const [cardElapsedMs, setCardElapsedMs] = useState(0);
    const activeCardRef = useRef<PreviewSegment | null>(null);
    const cardStartRef = useRef(0);
    const resumeTimerRef = useRef<number | null>(null);
    const consumedCardsRef = useRef<Set<string>>(new Set());

    const formatTime = (timeSec: number) => {
        if (!isFinite(timeSec) || isNaN(timeSec)) return '00:00:00';
        // MM:SS:FF at the recording's frame rate (video-editor convention).
        const fps = RECORDING_CONFIG.CANVAS.DEFAULT_FPS;
        const totalFrames = Math.max(0, Math.round(timeSec * fps));
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${pad(Math.floor(totalFrames / (fps * 60)))}:${pad(Math.floor(totalFrames / fps) % 60)}:${pad(totalFrames % fps)}`;
    };

    // Restore the saved playback volume once on mount.
    useEffect(() => {
        try {
            const saved = parseFloat(localStorage.getItem(VOLUME_STORAGE_KEY) ?? '');
            if (isFinite(saved) && saved >= 0 && saved <= 1) setVolume(saved);
        } catch { /* ignore */ }
    }, []);

    // Apply to the element only — persistence happens in the user handlers
    // (writing here would clobber the saved value on mount/remount).
    useEffect(() => {
        const video = videoRef.current;
        if (video) video.volume = volume;
    }, [volume]);

    const changeVolume = useCallback((v: number) => {
        setVolume(v);
        try { localStorage.setItem(VOLUME_STORAGE_KEY, String(v)); } catch { /* ignore */ }
    }, []);

    const previewDurMs = useMemo(() => (preview ? previewDurationMs(preview.segments) : 0), [preview]);

    // Source -> output with card context. A card's illustrative source span
    // [fromMs, fromMs + durationMs) overlaps the footage that follows it, so
    // the mapping depends on whether the hold has played: an unconsumed card
    // reads as "at the card" (its output start), and just after the hold the
    // race window right before the insertion point maps to the hold's end.
    // Without this the bar stalls on the card's start after every hold, then
    // jumps — and briefly jumps back at resume.
    const outMsFor = useCallback((srcMs: number): number => {
        if (!preview) return srcMs;
        for (let i = 0; i < preview.segments.length; i++) {
            const s = preview.segments[i];
            if (s.kind !== 'card' || !s.card) continue;
            const played = consumedCardsRef.current.has(s.card.id);
            const next = preview.segments[i + 1];
            const overlapEnd = next && next.kind === 'source'
                ? Math.min(s.fromMs + s.durationMs, next.toMs)
                : s.fromMs + s.durationMs;
            if (!played && srcMs >= s.fromMs && srcMs < overlapEnd) {
                return s.outMs;
            }
            if (played && srcMs >= s.fromMs - 350 && srcMs < s.fromMs) {
                return s.outMs + s.durationMs;
            }
        }
        return toOutputMs(preview.segments, srcMs);
    }, [preview]);

    // What the clock and progress bar show: edited (output) time when a
    // preview is active, the raw source time otherwise.
    const displayDurationSec = preview ? previewDurMs / 1000 : duration;
    const displayCurrentSec = activeCard
        ? (activeCard.outMs + Math.min(cardElapsedMs, activeCard.durationMs)) / 1000
        : preview
            ? outMsFor(currentTime * 1000) / 1000
            : currentTime;

    const seekToOutputSec = useCallback((outSec: number) => {
        const video = videoRef.current;
        if (!video) return;
        const clamped = Math.max(0, Math.min(outSec, displayDurationSec || outSec));
        video.currentTime = preview
            ? toSourceMs(preview.segments, clamped * 1000) / 1000
            : clamped;
    }, [preview, displayDurationSec]);

    const getSafeDuration = useCallback(() => {
        const video = videoRef.current;
        if (!video) return 0;
        const dur = video.duration;
        if (!isFinite(dur) || isNaN(dur)) return 0;
        return dur;
    }, []);

    const togglePlay = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        // A title card is playing out its fixed duration - not user-driven.
        if (activeCardRef.current) return;

        if (isPlaying) {
            video.pause();
        } else {
            video.play();
        }
        setIsPlaying(!isPlaying);
    }, [isPlaying]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const fixDuration = async () => {
            if (video.readyState < 1) {
                await new Promise(resolve => {
                    video.addEventListener('loadedmetadata', resolve, { once: true });
                });
            }

            if (!isFinite(video.duration) || isNaN(video.duration)) {
                const wasPlaying = !video.paused;

                video.currentTime = Number.MAX_SAFE_INTEGER;

                await new Promise(resolve => {
                    video.addEventListener('timeupdate', function handler() {
                        video.removeEventListener('timeupdate', handler);
                        resolve(null);
                    });
                    setTimeout(resolve, 500);
                });

                const realDuration = video.currentTime;
                video.currentTime = 0;

                if (isFinite(realDuration) && realDuration > 0) {
                    setDuration(realDuration);
                    onLoadedMetadata?.(realDuration);
                }

                if (wasPlaying) {
                    video.play();
                }
            } else {
                setDuration(video.duration);
                onLoadedMetadata?.(video.duration);
            }

            setIsReady(true);
        };

        fixDuration();
    }, [src, onLoadedMetadata]);

    useEffect(() => {
        onVideoElement?.(videoRef.current);
        return () => onVideoElement?.(null);
    }, [onVideoElement]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        const handleTimeUpdate = () => {
            const time = video.currentTime;
            if (isFinite(time)) {
                setCurrentTime(time);
                onTimeUpdate?.(time * 1000);
            }
        };
        const handleEnded = () => setIsPlaying(false);
        const handlePlay = () => setIsPlaying(true);
        const handlePause = () => setIsPlaying(false);
        const handleDurationChange = () => {
            const dur = getSafeDuration();
            if (dur > 0) setDuration(dur);
        };

        video.addEventListener('timeupdate', handleTimeUpdate);
        video.addEventListener('durationchange', handleDurationChange);
        video.addEventListener('ended', handleEnded);
        video.addEventListener('play', handlePlay);
        video.addEventListener('pause', handlePause);

        return () => {
            video.removeEventListener('timeupdate', handleTimeUpdate);
            video.removeEventListener('durationchange', handleDurationChange);
            video.removeEventListener('ended', handleEnded);
            video.removeEventListener('play', handlePlay);
            video.removeEventListener('pause', handlePause);
        };
    }, [getSafeDuration, onTimeUpdate]);

    // ---- Edit preview supervision: skip removed regions, play title cards ----
    useEffect(() => {
        if (!preview) return;
        const video = videoRef.current;
        if (!video) return;

        const dismissCard = () => {
            if (resumeTimerRef.current !== null) {
                window.clearTimeout(resumeTimerRef.current);
                resumeTimerRef.current = null;
            }
            activeCardRef.current = null;
            setActiveCard(null);
            onCardProgressRef.current?.(null);
        };

        // A user seek replays cards behind the new position only when they
        // are scrubbed past; cards ahead stay fresh and play when reached.
        const handleSeeking = () => {
            const t = (videoRef.current?.currentTime ?? 0) * 1000;
            for (const s of preview.segments) {
                if (s.kind !== 'card' || !s.card) continue;
                if (t > s.fromMs + 100) consumedCardsRef.current.add(s.card.id);
                else consumedCardsRef.current.delete(s.card.id);
            }
            if (activeCardRef.current) dismissCard();
        };
        video.addEventListener('seeking', handleSeeking);

        const tick = window.setInterval(() => {
            const v = videoRef.current;
            if (!v) return;
            const card = activeCardRef.current;
            if (card) {
                const elapsed = Math.min(performance.now() - cardStartRef.current, card.durationMs);
                setCardElapsedMs(elapsed);
                // The <video> is paused during a hold, so `timeupdate` goes
                // quiet and the edit playhead would starve. Keep feeding it
                // (parked at the card's insertion point) and the hold
                // progress from the same clock that drives the bar.
                onTimeUpdateRef.current?.(card.fromMs);
                onCardProgressRef.current?.({
                    cardId: card.card?.id ?? '',
                    fraction: card.durationMs > 0 ? elapsed / card.durationMs : 1,
                });
                return;
            }
            if (v.paused) return;
            const srcMs = v.currentTime * 1000;

            // Title card: hold on the overlay for its duration, then resume
            // at the insertion point (same content order as the export).
            for (const s of preview.segments) {
                if (
                    s.kind === 'card' && s.card &&
                    !consumedCardsRef.current.has(s.card.id) &&
                    srcMs >= s.fromMs - 25 && srcMs < s.fromMs + 300
                ) {
                    consumedCardsRef.current.add(s.card.id);
                    activeCardRef.current = s;
                    cardStartRef.current = performance.now();
                    setCardElapsedMs(0);
                    setActiveCard(s);
                    v.pause();
                    resumeTimerRef.current = window.setTimeout(() => {
                        dismissCard();
                        videoRef.current?.play().catch(() => { });
                    }, s.durationMs);
                    return;
                }
            }

            // Trimmed/cut regions do not exist in the edit: jump over them.
            const inKept = preview.segments.some(
                (s) => s.kind === 'source' && srcMs >= s.fromMs && srcMs < s.toMs
            );
            if (!inKept) {
                const next = preview.segments.find((s) => s.kind === 'source' && s.fromMs > srcMs);
                if (next) {
                    v.currentTime = next.fromMs / 1000 + 0.001;
                    return;
                }
                // Past the edited end: stop and rewind to the edited start.
                v.pause();
                const first = preview.segments.find((s) => s.kind === 'source');
                if (first) v.currentTime = first.fromMs / 1000;
            }
        }, 60);

        return () => {
            window.clearInterval(tick);
            video.removeEventListener('seeking', handleSeeking);
            dismissCard();
        };
    }, [preview]);

    const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const progressBar = progressRef.current;
        if (!progressBar || displayDurationSec <= 0) return;

        const rect = progressBar.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const pct = clickX / rect.width;
        const newTime = pct * displayDurationSec;

        if (isFinite(newTime) && newTime >= 0) {
            seekToOutputSec(newTime);
        }
    }, [displayDurationSec, seekToOutputSec]);

    const handleProgressDrag = useCallback((e: MouseEvent) => {
        if (!isDragging || displayDurationSec <= 0) return;
        const progressBar = progressRef.current;
        if (!progressBar) return;

        const rect = progressBar.getBoundingClientRect();
        const dragX = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, dragX / rect.width));
        const newTime = pct * displayDurationSec;

        if (isFinite(newTime)) {
            seekToOutputSec(newTime);
        }
    }, [isDragging, displayDurationSec, seekToOutputSec]);

    useEffect(() => {
        if (isDragging) {
            const stopDragging = () => setIsDragging(false);
            document.addEventListener('mousemove', handleProgressDrag);
            document.addEventListener('mouseup', stopDragging);
            return () => {
                document.removeEventListener('mousemove', handleProgressDrag);
                document.removeEventListener('mouseup', stopDragging);
            };
        }
    }, [isDragging, handleProgressDrag]);

    const progress = displayDurationSec > 0 ? (displayCurrentSec / displayDurationSec) * 100 : 0;

    return (
        <div className="relative w-full aspect-video bg-black rounded-xl sm:rounded-2xl overflow-hidden group shadow-xl border border-gray-700">
            <div
                className="absolute inset-0 cursor-pointer z-10"
                onClick={togglePlay}
            />

            <video
                ref={videoRef}
                src={src}
                className="w-full h-full object-contain"
                playsInline
                preload="auto"
            />

            {activeCard && preview && (
                <div className="absolute inset-0 z-20 bg-black" data-testid="card-preview-overlay">
                    {preview.cardImages[activeCard.card?.id ?? ''] ? (
                        <Image
                            src={preview.cardImages[activeCard.card?.id ?? '']}
                            alt={activeCard.card?.text ?? 'Title card'}
                            fill
                            unoptimized
                            className="object-contain"
                            draggable={false}
                        />
                    ) : (
                        /* Fallback when the pre-rendered card image is missing:
                           draw the text in the card's box, not centered on black. */
                        <div
                            className="absolute flex items-center justify-center overflow-hidden"
                            style={{
                                left: `${(activeCard.card?.box.x ?? 0) * 100}%`,
                                top: `${(activeCard.card?.box.y ?? 0) * 100}%`,
                                width: `${(activeCard.card?.box.w ?? 1) * 100}%`,
                                height: `${(activeCard.card?.box.h ?? 1) * 100}%`,
                                backgroundColor: activeCard.card?.bgColor ?? 'rgba(17, 24, 39, 0.85)',
                                borderRadius: '0.5rem',
                            }}
                            data-testid="card-preview-fallback-box"
                        >
                            <span
                                className="text-xl font-semibold px-4 text-center"
                                style={{ color: activeCard.card?.textColor ?? '#f9fafb' }}
                            >
                                {activeCard.card?.text}
                            </span>
                        </div>
                    )}
                </div>
            )}

            {!isReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-20">
                    <div className="w-8 h-8 sm:w-10 sm:h-10 border-4 border-white/30 border-t-white rounded-full animate-spin" />
                </div>
            )}

            {!isPlaying && isReady && !activeCard && (
                <div
                    className="absolute inset-0 flex items-center justify-center z-10 cursor-pointer"
                    onClick={togglePlay}
                >
                    <div className="w-16 h-16 sm:w-20 sm:h-20 flex items-center justify-center bg-white/90 hover:bg-white active:bg-white rounded-full shadow-2xl transition-transform hover:scale-105 active:scale-95">
                        <Play size={28} className="sm:w-8 sm:h-8 text-gray-900 ml-1" fill="currentColor" />
                    </div>
                </div>
            )}

            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3 sm:p-4 opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-30 touch-none pointer-events-none group-hover:pointer-events-auto">
                <div
                    ref={progressRef}
                    className="relative h-2 sm:h-1.5 bg-white/30 rounded-full cursor-pointer mb-2 sm:mb-3 group/progress pointer-events-auto"
                    onClick={handleProgressClick}
                    onMouseDown={() => displayDurationSec > 0 && setIsDragging(true)}
                >
                    <div
                        className="absolute top-0 left-0 h-full bg-indigo-500 rounded-full transition-all"
                        style={{ width: `${Math.min(100, progress)}%` }}
                    />
                    <div
                        className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 sm:w-4 sm:h-4 bg-white rounded-full shadow-lg opacity-0 group-hover/progress:opacity-100 transition-opacity"
                        style={{ left: `calc(${Math.min(100, progress)}% - ${window.innerWidth < 640 ? '7px' : '8px'})` }}
                    />
                </div>

                <div className="flex items-center gap-2 sm:gap-3 md:gap-4 pointer-events-auto">
                    <button
                        onClick={togglePlay}
                        className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center bg-white/20 hover:bg-white/30 active:bg-white/40 rounded-full transition shrink-0"
                    >
                        {isPlaying ? (
                            <Pause size={18} className="sm:w-5 sm:h-5 text-white" fill="white" />
                        ) : (
                            <Play size={18} className="sm:w-5 sm:h-5 text-white ml-0.5" fill="white" />
                        )}
                    </button>

                    <span className="text-white text-xs sm:text-sm font-medium tabular-nums">
                        {formatTime(displayCurrentSec)} / {formatTime(displayDurationSec)}
                    </span>

                    <div className="flex items-center gap-1.5 sm:gap-2 pointer-events-auto" data-testid="volume-control">
                        <button
                            onClick={() => changeVolume(volume > 0 ? 0 : 1)}
                            className="text-white/90 hover:text-white transition shrink-0"
                            aria-label={volume > 0 ? 'Mute' : 'Unmute'}
                            data-testid="volume-mute"
                        >
                            {volume > 0 ? (
                                <Volume2 size={18} className="sm:w-5 sm:h-5" />
                            ) : (
                                <VolumeX size={18} className="sm:w-5 sm:h-5" />
                            )}
                        </button>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={volume}
                            onChange={(e) => changeVolume(Number(e.target.value))}
                            className="w-16 sm:w-24 h-1.5 accent-indigo-400 cursor-pointer"
                            aria-label="Playback volume"
                            data-testid="volume-slider"
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
