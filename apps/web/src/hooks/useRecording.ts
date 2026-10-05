import { useCallback, useEffect, useRef, useState } from 'react';
import { SUPPORTED_CODECS, RECORDING_CONFIG } from '@/config/recording';
import {
  createRecordingSink,
  RecordingSink,
  StorageBackend,
  StorageMode,
} from '@/utils/recordingStorage';

interface UseRecordingOptions {
  onRecordingComplete: (blob: Blob) => void;
  /** Where to spool recorded chunks. See recordingStorage for mode semantics. */
  storageMode?: StorageMode;
}

export function useRecording({ onRecordingComplete, storageMode = 'auto' }: UseRecordingOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [error, setError] = useState<RecordingError | null>(null);
  const [storageBackend, setStorageBackend] = useState<StorageBackend | null>(null);
  /** True only when disk was forced and the sink actually had to fall back to RAM. */
  const [storageDegraded, setStorageDegraded] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  /** Sink still receiving chunks (write phase). */
  const sinkRef = useRef<RecordingSink | null>(null);
  /**
   * Sink whose finished file backs the recording currently held by the UI.
   * Its file must NOT be deleted until the UI drops that recording — see the
   * ownership notes in recordingStorage. Deleting it early turns the handed-out
   * blob into a zombie (stale size, every read throws).
   */
  const keptSinkRef = useRef<RecordingSink | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isPausedRef = useRef(false);
  const isStoppingRef = useRef(false);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  const clearTimer = useCallback(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async (stream: MediaStream): Promise<boolean> => {
    // 'paused' counts as active — restarting over a paused recorder would
    // detach (and destroy) its still-live sink.
    if (
      isStoppingRef.current ||
      (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive')
    ) {
      return false;
    }

    setError(null);
    isStoppingRef.current = false;

    if (!stream || stream.getTracks().length === 0) {
      throw new RecordingError(
        RecordingErrorCode.STREAM_INACTIVE,
        'Invalid or empty stream provided',
        true,
        'Please select a screen or camera to record'
      );
    }

    const codec = findSupportedCodec();
    if (!codec) {
      throw new RecordingError(
        RecordingErrorCode.CODEC_NOT_SUPPORTED,
        'No supported codec found',
        false,
        'Your browser does not support video recording'
      );
    }

    // Release the previous recording's stored file (the UI has dropped it by
    // now — a new recording replaces the previous one) plus any unfinished sink.
    const previousSink = sinkRef.current;
    sinkRef.current = null;
    void previousSink?.discard();
    const previousKept = keptSinkRef.current;
    keptSinkRef.current = null;
    void previousKept?.discard();

    // Chunks are spooled to disk (OPFS) so RAM stays flat for long recordings
    const sink = await createRecordingSink(codec.mimeType || 'video/webm', storageMode);
    sinkRef.current = sink;
    setStorageBackend(sink.backend);
    setStorageDegraded(storageMode === 'opfs' && sink.backend === 'memory');

    // If the encoder refuses this stream/mime, release the just-created sink so
    // no orphaned temp file is left behind, then let the caller report it.
    let mediaRecorder: MediaRecorder;
    try {
      mediaRecorder = new MediaRecorder(stream, {
        mimeType: codec.mimeType,
        videoBitsPerSecond: codec.videoBitsPerSecond,
        audioBitsPerSecond: RECORDING_CONFIG.AUDIO.BITRATE,
      });
    } catch (err) {
      if (sinkRef.current === sink) sinkRef.current = null;
      await sink.discard();
      throw err;
    }

    mediaRecorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = (event) => {
      if (event.data?.size > 0) {
        sink.write(event.data);
      }
    };

    mediaRecorder.onerror = (e: Event & { error?: DOMException }) => {
      const recErr = e.error
        ? RecordingError.fromDOMException(e.error)
        : new RecordingError(RecordingErrorCode.RECORDER_FAILED, 'MediaRecorder error', true);
      setError(recErr);
      clearTimer();
      setIsRecording(false);
      isStoppingRef.current = false;
    };

    mediaRecorder.onstop = () => {
      clearTimer();
      setIsRecording(false);
      setIsPaused(false);
      isStoppingRef.current = false;

      void (async () => {
        // The sink was replaced or discarded (e.g. page unmount) - nothing to finish
        if (sinkRef.current !== sink) return;
        try {
          const result = await sink.finish();
          if (sinkRef.current === sink) sinkRef.current = null;
          // From here on the returned blob OWNS the sink's file; it may only be
          // released once the UI drops the recording.
          keptSinkRef.current = sink;
          if (result.size > 0) {
            onRecordingComplete(result.blob);
          } else {
            setError(new RecordingError(
              RecordingErrorCode.RECORDER_FAILED,
              'Recording produced no data',
              true,
              'Recording failed: no data captured'
            ));
          }
        } catch (err) {
          if (sinkRef.current === sink) sinkRef.current = null;
          setError(new RecordingError(
            RecordingErrorCode.RECORDER_FAILED,
            'Failed to store recording',
            true,
            err instanceof Error ? `Failed to save the recording: ${err.message}` : 'Failed to save the recording to disk'
          ));
        }
      })();
    };

    try {
      mediaRecorder.start(1000);
    } catch (err) {
      mediaRecorderRef.current = null;
      if (sinkRef.current === sink) sinkRef.current = null;
      await sink.discard();
      throw err;
    }
    setIsRecording(true);
    setRecordingTime(0);

    timerIntervalRef.current = setInterval(() => {
      if (!isPausedRef.current) {
        setRecordingTime((prev) => prev + 1);
      }
    }, 1000);

    return true;
  }, [onRecordingComplete, clearTimer, storageMode]);

  /** Drop the stored recording the UI has released (e.g. "New recording"). */
  const releaseStoredRecording = useCallback(() => {
    const kept = keptSinkRef.current;
    keptSinkRef.current = null;
    void kept?.discard();
    // No recording in the UI anymore: the storage badge goes back to showing
    // the mode ("Storage: Automatic / Disk (forced) / RAM (forced)") instead of
    // where the released recording had been stored.
    setStorageBackend(null);
    setStorageDegraded(false);
  }, []);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || !isRecording || isStoppingRef.current) return;

    isStoppingRef.current = true;

    try { recorder.requestData(); } catch { /* ignore */ }

    setTimeout(() => {
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* ignore */ }
      }
    }, RECORDING_CONFIG.TIMING.RECORDER_STOP_DELAY);
  }, [isRecording]);

  const pauseRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || !isRecording) return;

    if (isPaused) {
      try { recorder.resume(); } catch { /* ignore */ }
      setIsPaused(false);
    } else {
      try { recorder.pause(); } catch { /* ignore */ }
      setIsPaused(true);
    }
  }, [isRecording, isPaused]);

  const cleanup = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state !== 'inactive') {
      try { recorder?.stop(); } catch { /* ignore */ }
    }

    clearTimer();

    recorder?.stream.getTracks().forEach(track => {
      try { track.stop(); } catch { /* ignore */ }
    });

    mediaRecorderRef.current = null;
    void sinkRef.current?.discard();
    sinkRef.current = null;
    void keptSinkRef.current?.discard();
    keptSinkRef.current = null;
    isStoppingRef.current = false;
  }, [clearTimer]);

  useEffect(() => cleanup, [cleanup]);

  return {
    isRecording,
    isPaused,
    recordingTime,
    error,
    storageBackend,
    storageDegraded,
    startRecording,
    stopRecording,
    pauseRecording,
    cleanup,
    releaseStoredRecording,
  };
}

export enum RecordingErrorCode {
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  DEVICE_NOT_FOUND = 'DEVICE_NOT_FOUND',
  RECORDER_FAILED = 'RECORDER_FAILED',
  STREAM_INACTIVE = 'STREAM_INACTIVE',
  CODEC_NOT_SUPPORTED = 'CODEC_NOT_SUPPORTED',
  UNKNOWN = 'UNKNOWN',
}

export class RecordingError extends Error {
  constructor(
    public code: RecordingErrorCode,
    message: string,
    public recoverable: boolean = false,
    public userMessage?: string
  ) {
    super(message);
    this.name = 'RecordingError';
  }

  static fromDOMException(error: DOMException): RecordingError {
    const errorMap: Record<string, RecordingErrorCode> = {
      'NotAllowedError': RecordingErrorCode.PERMISSION_DENIED,
      'NotFoundError': RecordingErrorCode.DEVICE_NOT_FOUND,
      'NotReadableError': RecordingErrorCode.DEVICE_NOT_FOUND,
      'OverconstrainedError': RecordingErrorCode.DEVICE_NOT_FOUND,
    };

    const code = errorMap[error.name] || RecordingErrorCode.UNKNOWN;
    const userMessages: Record<RecordingErrorCode, string> = {
      [RecordingErrorCode.PERMISSION_DENIED]: 'Please grant camera/microphone permissions',
      [RecordingErrorCode.DEVICE_NOT_FOUND]: 'No camera or microphone found',
      [RecordingErrorCode.RECORDER_FAILED]: 'Recording failed. Please try again',
      [RecordingErrorCode.STREAM_INACTIVE]: 'Recording stream became inactive',
      [RecordingErrorCode.CODEC_NOT_SUPPORTED]: 'Your browser does not support recording',
      [RecordingErrorCode.UNKNOWN]: 'An unexpected error occurred',
    };

    return new RecordingError(
      code,
      error.message,
      code !== RecordingErrorCode.CODEC_NOT_SUPPORTED,
      userMessages[code]
    );
  }
}

function findSupportedCodec(): MediaRecorderOptions | null {
  for (const codec of SUPPORTED_CODECS) {
    if (MediaRecorder.isTypeSupported(codec.mimeType)) {
      return { ...codec };
    }
  }

  return null;
}
