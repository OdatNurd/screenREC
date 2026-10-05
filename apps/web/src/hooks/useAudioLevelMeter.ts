'use client';

import { useEffect, useRef, useState } from 'react';

export interface AudioLevel {
    /** RMS level, 0..1 */
    level: number;
    /** Peak level with slow decay, 0..1 */
    peak: number;
}

/**
 * Real-time level meter for an audio stream.
 * The analyser is a tap only — it is never routed to the audio output,
 * so it cannot cause feedback.
 */
export function useAudioLevelMeter(stream: MediaStream | null): AudioLevel {
    const [level, setLevel] = useState(0);
    const [peak, setPeak] = useState(0);
    const peakRef = useRef(0);

    useEffect(() => {
        if (!stream || stream.getAudioTracks().length === 0) {
            setLevel(0);
            setPeak(0);
            peakRef.current = 0;
            return;
        }

        const AudioCtx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const audioCtx = new AudioCtx();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.3;
        source.connect(analyser);

        const data = new Float32Array(analyser.fftSize);
        let raf = 0;

        const tick = () => {
            analyser.getFloatTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
                sum += data[i] * data[i];
            }
            const rms = Math.sqrt(sum / data.length);
            // Perceptual-ish scaling: quiet speech sits well above the floor
            const scaled = Math.min(1, Math.sqrt(rms) * 2.2);
            peakRef.current = Math.max(scaled, peakRef.current * 0.95);
            setLevel(scaled);
            setPeak(peakRef.current);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);

        return () => {
            cancelAnimationFrame(raf);
            try { source.disconnect(); } catch { /* ignore */ }
            analyser.disconnect();
            audioCtx.close().catch(() => { });
        };
    }, [stream]);

    return { level, peak };
}
