'use client';

interface AudioLevelMeterProps {
    /** RMS level 0..1 */
    level: number;
    /** Peak level 0..1 (with decay) */
    peak: number;
    segmentCount?: number;
}

/**
 * Segmented VU-style level bar (green / yellow / red) with a peak marker.
 */
export default function AudioLevelMeter({ level, peak, segmentCount = 16 }: AudioLevelMeterProps) {
    const activeSegments = Math.round(level * segmentCount);
    const peakSegment = Math.min(segmentCount - 1, Math.round(peak * segmentCount) - 1);

    return (
        <div
            className="flex items-center gap-[2px]"
            role="meter"
            aria-label="Microphone input level"
            aria-valuenow={Math.round(level * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
        >
            {Array.from({ length: segmentCount }, (_, i) => {
                const isActive = i < activeSegments;
                const isPeak = i === peakSegment && peak > 0.02 && !isActive;
                let color = 'bg-gray-700';
                if (isActive || isPeak) {
                    if (i >= segmentCount - 2) color = 'bg-red-500';
                    else if (i >= segmentCount - 5) color = 'bg-yellow-400';
                    else color = 'bg-green-500';
                }
                return (
                    <span
                        key={i}
                        className={`h-3 w-1 rounded-sm transition-colors duration-75 ${color} ${isPeak ? 'opacity-70' : ''}`}
                    />
                );
            })}
        </div>
    );
}
