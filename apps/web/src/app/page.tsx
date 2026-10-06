'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import RecordingControls from '@/components/RecordingControls';
import Header from '@/components/Header';
import VideoPreview from '@/components/VideoPreview';
import MinimalVideoPlayer from '@/components/MinimalVideoPlayer';
import PlaybackControls from '@/components/PlaybackControls';
import CountdownOverlay from '@/components/CountdownOverlay';
import Notification from '@/components/Notification';
import DownloadSettingsModal, { DownloadSettings } from '@/components/DownloadSettingsModal';
import MediaSettings from '@/components/MediaSettings';
import EditTimeline from '@/components/EditTimeline';
import TitleCardModal from '@/components/TitleCardModal';
import { useMediaStreams } from '@/hooks/useMediaStreams';
import { useRecording } from '@/hooks/useRecording';
import { useCameraPosition } from '@/hooks/useCameraPosition';
import { useNotifications } from '@/hooks/useNotifications';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useDeviceList } from '@/hooks/useDeviceList';
import { useAudioLevelMeter } from '@/hooks/useAudioLevelMeter';
import { convertToMp4 as convertToMp4Api, ApiAuthError, ApiUnreachableError } from '@/services/api';
import { saveBlob } from '@/utils/saveFile';
import { isBlobReadable, StorageMode } from '@/utils/recordingStorage';
import {
  createWorkerCombinedStream,
  forceCleanupCombinedStreams,
} from '@/utils/workerStreamCombiner';
import {
  indexRecording,
  renderEdl,
  estimateEditedBytes,
  keptRanges,
  reencodeSubGop,
  generateTitleCard,
  buildPreviewSegments,
  grabFrame,
  drawTitleCard,
  type EdlState,
  type IndexedRecording,
  type TitleCardSpec,
} from '@/utils/webmEdit';
import { getResolutionDimensions, ResolutionPreset } from '@/config/recording';
import { RecordingLayout } from '@/types/layout';

const CAMERA_DEVICE_KEY = 'screenrec-camera-device';
const MIC_DEVICE_KEY = 'screenrec-mic-device';
const STORAGE_MODE_KEY = 'screenrec-storage-mode';
const MIRROR_KEY = 'screenrec-mirror-preview';

interface EffectCapabilities {
  blur: boolean | null;
  greenScreen: boolean | null;
}

/** Capability fields from the native Background Blur / Segmentation Mask APIs. */
type EffectCapFields = MediaTrackCapabilities & {
  backgroundBlur?: boolean[];
  backgroundSegmentationMask?: boolean[];
};

/** Constraint fields from the native Background Segmentation Mask API. */
type GreenScreenConstraints = MediaTrackConstraints & {
  backgroundSegmentationMask?: boolean;
};

export default function RecordPage() {
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [selectedLayout, setSelectedLayout] = useState<RecordingLayout>('pip');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [conversionProgress, setConversionProgress] = useState(0);

  // ---- Editing (trim / interior cuts / title cards) ----
  const [editMode, setEditMode] = useState(false);
  const [editIndex, setEditIndex] = useState<IndexedRecording | null>(null);
  const [edl, setEdl] = useState<EdlState | null>(null);
  const [edlPast, setEdlPast] = useState<EdlState[]>([]);
  const [edlFuture, setEdlFuture] = useState<EdlState[]>([]);
  const [cardModalAtMs, setCardModalAtMs] = useState<number | null>(null);
  const [isRenderingEdit, setIsRenderingEdit] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const playerVideoRef = useRef<HTMLVideoElement | null>(null);

  // Pre-rendered title-card images (frozen frame + text panel) for the
  // WYSIWYG playback preview, keyed by card id.
  const cardImagesRef = useRef<Map<string, string>>(new Map());
  const [cardImages, setCardImages] = useState<Record<string, string>>({});

  /** Output-time playback schedule mirroring the renderer's layout. */
  const previewSchedule = useMemo(() => {
    if (!editIndex || !edl) return null;
    return buildPreviewSegments(editIndex, edl);
  }, [editIndex, edl]);

  // Stable identity matters: the player re-arms its playback supervisor when
  // this object changes, and the page re-renders on every timeupdate.
  const playerPreview = useMemo(
    () => (previewSchedule ? { segments: previewSchedule, cardImages } : null),
    [previewSchedule, cardImages]
  );

  useEffect(() => {
    let cancelled = false;
    if (!editIndex || !edl) return;
    (async () => {
      for (const card of edl.cards) {
        if (cardImagesRef.current.has(card.id)) continue;
        try {
          const frame = await grabFrame(editIndex, card.atMs);
          const canvas = document.createElement('canvas');
          canvas.width = editIndex.video?.width ?? 1280;
          canvas.height = editIndex.video?.height ?? 720;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            drawTitleCard(ctx, frame, card, canvas.width, canvas.height);
            cardImagesRef.current.set(card.id, canvas.toDataURL('image/png'));
          }
          frame.close();
        } catch {
          // Preview falls back to a plain text overlay for this card.
        }
        if (cancelled) return;
        setCardImages(Object.fromEntries(cardImagesRef.current));
      }
    })();
    return () => { cancelled = true; };
  }, [editIndex, edl]);

  // Device selection
  const [cameraDeviceId, setCameraDeviceId] = useState('');
  const [micDeviceId, setMicDeviceId] = useState('');

  // Where recorded chunks are spooled: 'auto' | 'opfs' (disk) | 'memory'
  const [storageMode, setStorageMode] = useState<StorageMode>('auto');

  // Camera preview mirroring (self-view). Default on; recorded output unaffected.
  const [mirrorPreview, setMirrorPreview] = useState(true);

  // Output resolution
  const [targetResolution, setTargetResolution] = useState<ResolutionPreset>('source');
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  // Actual dimensions of the recorded track (shown in the playback bar)
  const [recordingMeta, setRecordingMeta] = useState<{ width: number; height: number } | null>(null);

  // Native camera effects
  const [effectCaps, setEffectCaps] = useState<EffectCapabilities>({ blur: null, greenScreen: null });
  const [backgroundBlur, setBackgroundBlur] = useState(false);
  const [greenScreen, setGreenScreen] = useState(false);
  const [greenScreenColor, setGreenScreenColor] = useState('#00b140');

  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const { notifications, showNotification, removeNotification } = useNotifications();
  const { cameras, microphones, refresh: refreshDevices } = useDeviceList();

  // Mobile detection
  useEffect(() => {
    const checkMobile = () => {
      const ua = navigator.userAgent.toLowerCase();
      const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(ua);
      const isSmallScreen = window.innerWidth < 768;
      const isTouchOnly = navigator.maxTouchPoints > 0 && !window.matchMedia('(hover: hover)').matches;
      setIsMobile(isMobileUA || (isSmallScreen && isTouchOnly));
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Restore persisted device selection
  useEffect(() => {
    try {
      setCameraDeviceId(localStorage.getItem(CAMERA_DEVICE_KEY) || '');
      setMicDeviceId(localStorage.getItem(MIC_DEVICE_KEY) || '');
      const storedMode = localStorage.getItem(STORAGE_MODE_KEY);
      if (storedMode === 'auto' || storedMode === 'opfs' || storedMode === 'memory') {
        setStorageMode(storedMode);
      }
      const storedMirror = localStorage.getItem(MIRROR_KEY);
      if (storedMirror === 'on' || storedMirror === 'off') {
        setMirrorPreview(storedMirror === 'on');
      }
    } catch { /* storage unavailable */ }
  }, []);

  const {
    isScreenShared,
    isCameraOn,
    isMicOn,
    screenStreamRef,
    cameraStreamRef,
    audioStreamRef,
    handleShareScreen,
    startCamera,
    startMic,
    stopCamera,
    stopScreen,
    stopMic,
    stopAllStreams,
    toggleCamera,
    toggleMic,
  } = useMediaStreams();

  const {
    isRecording,
    isPaused,
    recordingTime,
    error: recordingError,
    storageBackend,
    storageDegraded,
    startRecording,
    stopRecording,
    pauseRecording,
    cleanup,
    releaseStoredRecording,
  } = useRecording({
    storageMode,
    onRecordingComplete: async (blob: Blob) => {
      if (blob.size === 0) {
        showNotification('Recording failed: no data captured', 'error');
        return;
      }
      if (!(await isBlobReadable(blob))) {
        showNotification('Recording could not be read back from storage — please record again', 'error');
        return;
      }

      setRecordedBlob(blob);
      const url = URL.createObjectURL(blob);
      setRecordedVideoUrl(url);
      showNotification('Recording saved!', 'success');
    },
  });

  const {
    cameraPosition,
    isDragging,
    handleCameraDragStart,
    handleCameraDrag,
    handleCameraDragEnd,
    getCameraPositionClasses,
    getCameraCanvasPosition,
  } = useCameraPosition();

  // Surface recorder/storage failures (errors persist until dismissed)
  useEffect(() => {
    if (recordingError) {
      showNotification(recordingError.userMessage || recordingError.message, 'error');
    }
  }, [recordingError, showNotification]);

  // VU meter tied to the active microphone stream (tap only, no output routing)
  const micStream = isMicOn ? audioStreamRef.current : null;
  const { level: micLevel, peak: micPeak } = useAudioLevelMeter(micStream);

  // VU meter for the captured tab/system audio (present only in captures that include audio)
  const [screenAudioStream, setScreenAudioStream] = useState<MediaStream | null>(null);
  useEffect(() => {
    const compute = () => {
      const tracks = isScreenShared ? screenStreamRef.current?.getAudioTracks() ?? [] : [];
      setScreenAudioStream((prev) => {
        const prevTracks = prev ? prev.getAudioTracks() : [];
        if (prevTracks.length === tracks.length && prevTracks.every((t, i) => t === tracks[i])) {
          return prev;
        }
        return tracks.length > 0 ? new MediaStream(tracks) : null;
      });
    };
    compute();
    if (!isScreenShared) return;
    const interval = setInterval(compute, 1000);
    return () => clearInterval(interval);
  }, [isScreenShared, screenStreamRef]);
  const hasSystemAudio = screenAudioStream !== null;
  const { level: systemLevel, peak: systemPeak } = useAudioLevelMeter(screenAudioStream);

  // Source size readout: track settings of the active primary source
  useEffect(() => {
    const compute = () => {
      const sTrack = screenStreamRef.current?.getVideoTracks()[0];
      const cTrack = cameraStreamRef.current?.getVideoTracks()[0];
      const settings = (sTrack ?? cTrack)?.getSettings();
      if (settings?.width && settings?.height) {
        setSourceSize({ width: settings.width, height: settings.height });
      } else {
        setSourceSize(null);
      }
    };
    compute();
    if (!isScreenShared && !isCameraOn) return;
    const interval = setInterval(compute, 1000);
    return () => clearInterval(interval);
  }, [isScreenShared, isCameraOn, screenStreamRef, cameraStreamRef]);

  // Native camera-effect capabilities (OS-side; no wasm)
  useEffect(() => {
    const probe = () => {
      const track = cameraStreamRef.current?.getVideoTracks()[0];
      if (!track || !isCameraOn) {
        setEffectCaps({ blur: null, greenScreen: null });
        setBackgroundBlur(false);
        setGreenScreen(false);
        return;
      }
      const caps = track.getCapabilities() as EffectCapFields | undefined;
      setEffectCaps({
        blur: caps?.backgroundBlur?.length === 2 ? true : null,
        greenScreen: caps?.backgroundSegmentationMask?.length === 2 ? true : null,
      });
      setBackgroundBlur(!!track.getSettings().backgroundBlur);
    };
    probe();
    // Capabilities can populate shortly after the track starts; re-probe once.
    const timer = setTimeout(probe, 750);
    return () => clearTimeout(timer);
  }, [isCameraOn, cameraStreamRef]);

  // Keep blur state in sync with OS-side toggles (macOS/ChromeOS control it externally)
  useEffect(() => {
    const track = cameraStreamRef.current?.getVideoTracks()[0];
    if (!track || !isCameraOn) return;
    const handler = () => setBackgroundBlur(!!track.getSettings().backgroundBlur);
    track.addEventListener('configurationchange', handler as EventListener);
    return () => track.removeEventListener('configurationchange', handler as EventListener);
  }, [isCameraOn, cameraStreamRef]);

  const handleShareScreenWithMobileCheck = useCallback(() => {
    if (isMobile) {
      showNotification('Screen sharing requires a desktop browser.', 'error');
      return;
    }
    handleShareScreen();
  }, [isMobile, showNotification, handleShareScreen]);

  const handleStartCamera = useCallback(async () => {
    await toggleCamera(cameraDeviceId || null);
    // Camera permission is granted by the time the toggle resolves, which
    // unredacts device labels/ids — re-enumerate so both pickers reflect the
    // full device list without a page refresh.
    refreshDevices();
  }, [toggleCamera, cameraDeviceId, refreshDevices]);

  const handleToggleMic = useCallback(async () => {
    await toggleMic(micDeviceId || null);
    // Same as above: mic permission unredacts the device list — refresh it now.
    refreshDevices();
  }, [toggleMic, micDeviceId, refreshDevices]);

  const handleCameraDeviceChange = useCallback(async (deviceId: string) => {
    setCameraDeviceId(deviceId);
    try { localStorage.setItem(CAMERA_DEVICE_KEY, deviceId); } catch { /* ignore */ }
    if (cameraStreamRef.current) {
      stopCamera();
      await startCamera(deviceId || null);
      refreshDevices();
    }
  }, [cameraStreamRef, stopCamera, startCamera, refreshDevices]);

  const handleMicDeviceChange = useCallback(async (deviceId: string) => {
    setMicDeviceId(deviceId);
    try { localStorage.setItem(MIC_DEVICE_KEY, deviceId); } catch { /* ignore */ }
    if (audioStreamRef.current) {
      // Swap the device while keeping the mic on
      stopMic();
      await startMic(deviceId || null);
      refreshDevices();
    }
  }, [audioStreamRef, stopMic, startMic, refreshDevices]);

  const handleToggleBackgroundBlur = useCallback(async () => {
    const track = cameraStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !backgroundBlur;
    try {
      await track.applyConstraints({ backgroundBlur: next });
      setBackgroundBlur(next);
    } catch {
      showNotification('Could not change background blur on this device.', 'error');
    }
  }, [backgroundBlur, cameraStreamRef, showNotification]);

  const handleToggleGreenScreen = useCallback(async () => {
    const track = cameraStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !greenScreen;
    try {
      await track.applyConstraints({ backgroundSegmentationMask: next } as GreenScreenConstraints);
      setGreenScreen(next);
    } catch {
      showNotification('Could not change green screen on this device.', 'error');
    }
  }, [greenScreen, cameraStreamRef, showNotification]);

  useKeyboardShortcuts({
    isRecording,
    isCameraOn,
    isScreenShared,
    onPause: pauseRecording,
    onToggleMic: handleToggleMic,
    onToggleCamera: () => isCameraOn ? stopCamera() : handleStartCamera(),
    onToggleScreen: () => isScreenShared ? stopScreen() : handleShareScreenWithMobileCheck(),
  });

  // Bind the live streams to whichever preview <video> element is mounted.
  // Runs after every render (idempotently) because VideoPreview swaps elements
  // when the layout mode changes (camera-only <-> PiP <-> screen-only).
  useEffect(() => {
    const videoElement = screenVideoRef.current;
    const stream = screenStreamRef.current;
    if (videoElement && videoElement.srcObject !== stream) {
      videoElement.srcObject = stream;
    }
  });

  useEffect(() => {
    const videoElement = cameraVideoRef.current;
    const stream = cameraStreamRef.current;
    if (videoElement && videoElement.srcObject !== stream) {
      videoElement.srcObject = stream;
    }
  });

  useEffect(() => {
    if (!recordedVideoUrl) {
      setIsVideoLoading(false);
      return;
    }
    setIsVideoLoading(false);
  }, [recordedVideoUrl]);

  // Keep the current object URL in a ref so the unmount cleanup below runs ONLY
  // on unmount. Listing recordedVideoUrl in its deps used to tear down
  // mid-session — stopping all capture streams and deleting the recording file
  // behind the blob the UI had just started showing — every time a recording
  // completed (and again for every later recording).
  const recordedVideoUrlRef = useRef<string | null>(null);
  useEffect(() => {
    recordedVideoUrlRef.current = recordedVideoUrl;
  }, [recordedVideoUrl]);

  useEffect(
    () => () => {
      stopAllStreams();
      cleanup();
      if (recordedVideoUrlRef.current) {
        URL.revokeObjectURL(recordedVideoUrlRef.current);
      }
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
      }
    },
    [stopAllStreams, cleanup]
  );

  useEffect(() => {
    if (isScreenShared && !screenStreamRef.current) {
      showNotification('Screen share failed. Please try again.', 'error');
    }
  }, [isScreenShared, screenStreamRef, showNotification]);

  useEffect(() => {
    if (isCameraOn && !cameraStreamRef.current) {
      showNotification('Camera access failed. Please check permissions.', 'error');
    }
  }, [isCameraOn, cameraStreamRef, showNotification]);

  useEffect(() => {
    if (isMicOn && !audioStreamRef.current) {
      showNotification('Microphone access failed. Please check permissions.', 'error');
    }
  }, [isMicOn, audioStreamRef, showNotification]);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isRecording) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isRecording]);

  const actuallyStartRecording = useCallback(async () => {
    // Assigned once the combined stream exists so any later failure can release it
    let releaseCombinedStream: (() => void) | null = null;
    try {
      if (!screenStreamRef.current && !cameraStreamRef.current && !audioStreamRef.current) {
        showNotification('No media sources available to record', 'error');
        return;
      }

      const { stream: combinedStream, cleanup: workerCleanup } = await createWorkerCombinedStream({
        screenStream: screenStreamRef.current,
        cameraStream: cameraStreamRef.current,
        audioStream: audioStreamRef.current,
        cameraPosition: getCameraCanvasPosition(),
        cameraPositionKey: cameraPosition,
        layout: selectedLayout,
        targetResolution: getResolutionDimensions(targetResolution),
        greenScreen: { enabled: greenScreen, color: greenScreenColor },
      });
      releaseCombinedStream = workerCleanup;

      if (combinedStream.getTracks().length === 0) {
        showNotification('No tracks available to record', 'error');
        workerCleanup();
        return;
      }

      // Capture the actual recorded dimensions for the playback bar
      const recordedSettings = combinedStream.getVideoTracks()[0]?.getSettings();
      setRecordingMeta(
        recordedSettings?.width && recordedSettings?.height
          ? { width: recordedSettings.width, height: recordedSettings.height }
          : getResolutionDimensions(targetResolution) ?? sourceSize
      );

      setRecordedBlob(null);
      setRecordedVideoUrl(null);

      const started = await startRecording(combinedStream);
      if (!started) {
        // Already recording (e.g. a double-start) — release the unused stream
        workerCleanup();
        return;
      }
      showNotification('Recording started!', 'success');
    } catch (error) {
      releaseCombinedStream?.();
      console.error('Error starting recording:', error);
      showNotification('Failed to start recording. Please try again.', 'error');
    }
  }, [
    screenStreamRef,
    cameraStreamRef,
    audioStreamRef,
    getCameraCanvasPosition,
    cameraPosition,
    selectedLayout,
    targetResolution,
    sourceSize,
    greenScreen,
    greenScreenColor,
    startRecording,
    showNotification,
  ]);

  const startCountdown = useCallback(() => {
    // A second click restarts the countdown instead of spawning a second one
    // (two countdowns would start two recordings).
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setCountdown(3);

    countdownIntervalRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null) {
          if (countdownIntervalRef.current) {
            clearInterval(countdownIntervalRef.current);
          }
          return null;
        }

        if (prev <= 1) {
          if (countdownIntervalRef.current) {
            clearInterval(countdownIntervalRef.current);
            countdownIntervalRef.current = null;
          }
          setTimeout(() => {
            actuallyStartRecording();
          }, 100);
          return null;
        }

        return prev - 1;
      });
    }, 1000);
  }, [actuallyStartRecording]);

  const handleStartRecording = useCallback(() => {
    let hasValidSource = false;
    const errorMessages: string[] = [];

    if (isScreenShared) {
      if (screenStreamRef.current) {
        hasValidSource = true;
      } else {
        errorMessages.push('Screen share is not working');
      }
    }

    if (isCameraOn) {
      if (cameraStreamRef.current) {
        hasValidSource = true;
      } else {
        errorMessages.push('Camera is not working');
      }
    }

    if (isMicOn && !audioStreamRef.current) {
      errorMessages.push('Microphone is not working');
    }

    if (errorMessages.length > 0) {
      errorMessages.forEach((msg) => showNotification(msg, 'error'));
      return;
    }

    if (!hasValidSource) {
      showNotification('Please enable screen share or camera before recording', 'info');
      return;
    }

    startCountdown();
  }, [
    isScreenShared,
    isCameraOn,
    isMicOn,
    screenStreamRef,
    cameraStreamRef,
    audioStreamRef,
    showNotification,
    startCountdown,
  ]);

  const handleStopRecording = useCallback(() => {
    // Stop the MediaRecorder first - this triggers onstop which creates the blob
    stopRecording();

    // Delay cleanup to allow MediaRecorder to finish processing
    setTimeout(() => {
      forceCleanupCombinedStreams();
      stopAllStreams();
    }, 500);
  }, [stopRecording, stopAllStreams]);

  const updateEdl = useCallback((next: EdlState) => {
    setEdlPast((past) => (edl ? [...past.slice(-49), edl] : past));
    setEdlFuture([]);
    setEdl(next);
  }, [edl]);

  const handleUndo = useCallback(() => {
    if (edlPast.length === 0 || !edl) return;
    const prev = edlPast[edlPast.length - 1];
    setEdlPast(edlPast.slice(0, -1));
    setEdlFuture([edl, ...edlFuture]);
    setEdl(prev);
  }, [edlPast, edl, edlFuture]);

  const handleRedo = useCallback(() => {
    if (edlFuture.length === 0 || !edl) return;
    const next = edlFuture[0];
    setEdlFuture(edlFuture.slice(1));
    setEdlPast([...edlPast, edl]);
    setEdl(next);
  }, [edlFuture, edl, edlPast]);

  const handleEditToggle = useCallback(async () => {
    if (editMode) {
      setEditMode(false);
      setCardModalAtMs(null);
      return;
    }
    if (!recordedBlob) return;
    try {
      const index = await indexRecording(recordedBlob);
      if (!index.video) {
        showNotification('This recording has no video track to edit', 'error');
        return;
      }
      setEditIndex(index);
      setEdl((prev) => prev ?? {
        trimStartMs: 0,
        trimEndMs: index.durationMs,
        cuts: [],
        cards: [],
        snapToKeyframes: true,
      });
      setEditMode(true);
    } catch (error) {
      showNotification(
        `Could not read recording for editing (${error instanceof Error ? error.message : 'unknown error'})`,
        'error'
      );
    }
  }, [editMode, recordedBlob, showNotification]);

  const handleSeek = useCallback((ms: number) => {
    const video = playerVideoRef.current;
    if (video) {
      video.currentTime = Math.max(0, ms / 1000);
    }
    setPlayheadMs(ms);
  }, []);

  const handleVideoElement = useCallback((el: HTMLVideoElement | null) => {
    playerVideoRef.current = el;
  }, []);

  const handleAddCard = useCallback((atMs: number) => {
    setCardModalAtMs(atMs);
  }, []);

  const handleCardConfirm = useCallback((spec: Omit<TitleCardSpec, 'id'>) => {
    if (!edl) return;
    updateEdl({ ...edl, cards: [...edl.cards, { ...spec, id: `card-${Date.now()}` }] });
    setCardModalAtMs(null);
  }, [edl, updateEdl]);

  /** Output duration of the current EDL (kept source spans + title cards). */
  const editedDurationMs = useMemo(() => {
    if (!editIndex || !edl) return 0;
    const kept = keptRanges(editIndex, edl).reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
    return kept + edl.cards.reduce((sum, c) => sum + c.durationMs, 0);
  }, [editIndex, edl]);

  const hasEdits = !!editIndex && !!edl && (
    edl.trimStartMs > 0 ||
    edl.trimEndMs < editIndex.durationMs - 1 ||
    edl.cuts.length > 0 ||
    edl.cards.length > 0
  );

  const handleDownload = useCallback(() => {
    if (!recordedBlob) return;
    setShowDownloadModal(true);
  }, [recordedBlob]);

  const handleDownloadConfirm = useCallback(async (settings: DownloadSettings) => {
    if (!recordedBlob) return;
    setShowDownloadModal(false);

    // Non-destructive: edits render to a copy; the original stays untouched.
    let sourceBlob = recordedBlob;
    if (settings.source === 'edited' && editIndex && edl && hasEdits) {
      setIsRenderingEdit(true);
      try {
        sourceBlob = await renderEdl(editIndex, edl, {
          generateCard: (spec) => generateTitleCard(editIndex, spec),
          reencodeSubGop: (fromMs, toMs) => reencodeSubGop(editIndex, fromMs, toMs),
        });
      } catch (error) {
        showNotification(
          `Could not apply edits (${error instanceof Error ? error.message : 'unknown error'}) — nothing was downloaded`,
          'error'
        );
        return;
      } finally {
        setIsRenderingEdit(false);
      }
      showNotification('Edits applied', 'success');
    }

    if (!(await isBlobReadable(sourceBlob))) {
      showNotification('Recording file is missing from storage — nothing was downloaded. Please record again.', 'error');
      return;
    }

    let blobToDownload = sourceBlob;
    let extension = 'webm';

    if (settings.format === 'mp4') {
      setIsConverting(true);
      setConversionProgress(0);
      showNotification('Converting to MP4 via server...', 'info');
      try {
        const mp4Blob = await convertToMp4Api(sourceBlob, {
          onProgress: setConversionProgress,
          password: settings.password,
        });
        if (mp4Blob) {
          blobToDownload = mp4Blob;
          extension = 'mp4';
          showNotification('Conversion complete!', 'success');
        } else {
          showNotification('MP4 conversion failed — downloading WebM instead', 'info');
        }
      } catch (error) {
        if (error instanceof ApiAuthError) {
          // Wrong password: do NOT silently substitute WebM — let the user retry
          setIsConverting(false);
          showNotification('Wrong password — MP4 was not converted. Your recording is still here; try again with the correct password.', 'error');
          return;
        }
        const reason = error instanceof ApiUnreachableError
          ? 'convert service unreachable'
          : error instanceof Error ? error.message : 'unknown error';
        showNotification(`MP4 conversion failed (${reason}) — downloading WebM instead`, 'info');
      } finally {
        setIsConverting(false);
      }
    }

    const filename = settings.name
      ? `${settings.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.${extension}`
      : `recording-${Date.now()}.${extension}`;
    const saved = await saveBlob(blobToDownload, filename);
    if (saved) {
      showNotification('Recording downloaded successfully', 'success');
    }
  }, [recordedBlob, editIndex, edl, hasEdits, showNotification]);

  const handleNewRecording = useCallback(() => {
    if (recordedVideoUrl) {
      URL.revokeObjectURL(recordedVideoUrl);
    }
    setRecordedBlob(null);
    setRecordedVideoUrl(null);
    setEditMode(false);
    setEditIndex(null);
    setEdl(null);
    setEdlPast([]);
    setEdlFuture([]);
    setCardModalAtMs(null);
    setPlayheadMs(0);
    // The UI has dropped the recording — release its storage (temp file)
    releaseStoredRecording();
  }, [recordedVideoUrl, releaseStoredRecording]);

  const handleStorageModeChange = useCallback((mode: StorageMode) => {
    setStorageMode(mode);
    try { localStorage.setItem(STORAGE_MODE_KEY, mode); } catch { /* ignore */ }
  }, []);

  const handleToggleMirrorPreview = useCallback(() => {
    const next = !mirrorPreview;
    setMirrorPreview(next);
    try { localStorage.setItem(MIRROR_KEY, next ? 'on' : 'off'); } catch { /* ignore */ }
  }, [mirrorPreview]);

  const handleCameraDragMove = useCallback(
    (e: React.MouseEvent) => {
      handleCameraDrag(e, previewContainerRef.current);
    },
    [handleCameraDrag]
  );

  const outputSize = getResolutionDimensions(targetResolution) ?? sourceSize;

  return (
    <div className="fixed inset-0 bg-gray-900 flex flex-col">
      <Header />

      {/* Download Settings Modal */}
      <DownloadSettingsModal
        isOpen={showDownloadModal}
        onClose={() => setShowDownloadModal(false)}
        onDownload={handleDownloadConfirm}
        videoBlob={recordedBlob}
        hasEdits={hasEdits}
        editedDurationMs={editedDurationMs}
        editedSizeBytes={editIndex && edl ? estimateEditedBytes(editIndex, edl) : 0}
        originalDurationMs={editIndex?.durationMs ?? 0}
      />

      {/* Title card editor */}
      {cardModalAtMs !== null && editIndex && (
        <TitleCardModal
          index={editIndex}
          atMs={cardModalAtMs}
          onConfirm={handleCardConfirm}
          onClose={() => setCardModalAtMs(null)}
        />
      )}

      <div className="fixed top-16 sm:top-20 left-1/2 -translate-x-1/2 z-50 h-20 px-4 w-full max-w-md">
        {notifications.slice().reverse().map((notification, index) => (
          <div
            key={notification.id}
            className="absolute left-1/2 transition-all duration-200 w-full"
            style={{
              zIndex: 100 - index,
              transform: `translateX(-50%) translateY(${index * -8}px)`,
              opacity: index > 3 ? 0.4 : 1 - index * 0.1,
            }}
          >
            <Notification
              message={notification.message}
              type={notification.type}
              onClose={() => removeNotification(notification.id)}
            />
          </div>
        ))}
      </div>

      {/* Applying-edits overlay */}
      {isRenderingEdit && (
        <div className="fixed inset-0 z-40 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-gray-800 border border-gray-700 rounded-2xl p-6 sm:p-8 shadow-2xl flex flex-col items-center gap-3 sm:gap-4 max-w-sm w-full mx-4">
            <div className="w-12 h-12 sm:w-16 sm:h-16 border-4 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin" />
            <h3 className="text-lg sm:text-xl font-semibold text-gray-100">Applying edits</h3>
            <p className="text-sm sm:text-base text-gray-400 text-center">Building your edited recording...</p>
          </div>
        </div>
      )}

      {/* Converting Overlay */}
      {isConverting && (
        <div className="fixed inset-0 z-40 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-gray-800 border border-gray-700 rounded-2xl p-6 sm:p-8 shadow-2xl flex flex-col items-center gap-3 sm:gap-4 max-w-sm w-full mx-4">
            <div className="w-12 h-12 sm:w-16 sm:h-16 border-4 border-indigo-500/30 border-t-indigo-400 rounded-full animate-spin" />
            <h3 className="text-lg sm:text-xl font-semibold text-gray-100">Converting to MP4</h3>
            <p className="text-sm sm:text-base text-gray-400 text-center">Please wait while your recording is being converted...</p>
            <div className="w-full bg-gray-700 rounded-full h-2">
              <div
                className="bg-indigo-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${conversionProgress}%` }}
              />
            </div>
            <span className="text-xs sm:text-sm text-gray-400">{conversionProgress}%</span>
          </div>
        </div>
      )}

      <main className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
        <div className="flex flex-col items-center gap-4 sm:gap-6 md:gap-8 w-full max-w-4xl mx-auto">
          {recordedVideoUrl ? (
            <div className="w-full flex flex-col gap-4 sm:gap-5 md:gap-6">
              <div className="w-full">
                {isVideoLoading && (
                  <div className="w-full aspect-video rounded-xl sm:rounded-2xl bg-gray-800 border border-gray-700 shadow-lg flex items-center justify-center">
                    <div className="flex flex-col items-center gap-2 sm:gap-3">
                      <div className="w-10 h-10 sm:w-12 sm:h-12 border-4 border-white/30 border-t-white rounded-full animate-spin" />
                      <p className="text-white text-xs sm:text-sm font-medium">Loading video...</p>
                    </div>
                  </div>
                )}
                {!isVideoLoading && recordedVideoUrl && (
                  <MinimalVideoPlayer
                    src={recordedVideoUrl}
                    onVideoElement={handleVideoElement}
                    onTimeUpdate={setPlayheadMs}
                    preview={playerPreview}
                  />
                )}
              </div>

              {/* Edit surface */}
              {editMode && editIndex && edl && (
                <EditTimeline
                  index={editIndex}
                  edl={edl}
                  playheadMs={playheadMs}
                  canUndo={edlPast.length > 0}
                  canRedo={edlFuture.length > 0}
                  onChange={updateEdl}
                  onSeek={handleSeek}
                  onAddCard={handleAddCard}
                  onUndo={handleUndo}
                  onRedo={handleRedo}
                  onDone={() => setEditMode(false)}
                />
              )}

              {/* Controls - Bottom */}
              <PlaybackControls
                onDownload={handleDownload}
                onNewRecording={handleNewRecording}
                videoBlob={recordedBlob}
                resolution={recordingMeta}
                storageBackend={storageBackend}
                storageDegraded={storageDegraded}
                onEdit={handleEditToggle}
                editActive={editMode}
                hasEdits={hasEdits}
              />
            </div>
          ) : (
            <div className="relative w-full" onMouseMove={handleCameraDragMove} onMouseUp={handleCameraDragEnd}>
              {countdown !== null && <CountdownOverlay count={countdown} />}

              <VideoPreview
                ref={previewContainerRef}
                isScreenShared={isScreenShared}
                isCameraOn={isCameraOn}
                isRecording={isRecording}
                isPaused={isPaused}
                recordingTime={recordingTime}
                screenVideoRef={screenVideoRef}
                cameraVideoRef={cameraVideoRef}
                cameraPositionClasses={getCameraPositionClasses()}
                isDragging={isDragging}
                selectedLayout={selectedLayout}
                mirrorPreview={mirrorPreview}
                onShareScreen={handleShareScreenWithMobileCheck}
                onStartCamera={handleStartCamera}
                onStopCamera={stopCamera}
                onCameraDragStart={handleCameraDragStart}
              />
            </div>
          )}

          {!recordedVideoUrl && (
            <>
              <MediaSettings
                cameras={cameras}
                microphones={microphones}
                selectedCameraId={cameraDeviceId}
                selectedMicId={micDeviceId}
                onCameraChange={handleCameraDeviceChange}
                onMicChange={handleMicDeviceChange}
                resolution={targetResolution}
                onResolutionChange={setTargetResolution}
                sourceSize={sourceSize}
                outputSize={outputSize}
                micLevel={micLevel}
                micPeak={micPeak}
                isMicOn={isMicOn}
                systemLevel={systemLevel}
                systemPeak={systemPeak}
                hasSystemAudio={hasSystemAudio}
                backgroundBlur={effectCaps.blur === true ? backgroundBlur : null}
                onToggleBackgroundBlur={handleToggleBackgroundBlur}
                greenScreen={effectCaps.greenScreen === true ? greenScreen : null}
                onToggleGreenScreen={handleToggleGreenScreen}
                greenScreenColor={greenScreenColor}
                onGreenScreenColorChange={setGreenScreenColor}
                storageMode={storageMode}
                storageBackend={storageBackend}
                storageDegraded={storageDegraded}
                onStorageModeChange={handleStorageModeChange}
                mirrorPreview={mirrorPreview}
                onToggleMirrorPreview={handleToggleMirrorPreview}
                isCameraOn={isCameraOn}
                disabled={isRecording}
              />

              <RecordingControls
                onStartRecording={handleStartRecording}
                onStopRecording={handleStopRecording}
                onPauseRecording={pauseRecording}
                onShareScreen={handleShareScreenWithMobileCheck}
                onStopScreen={stopScreen}
                onStartCamera={handleStartCamera}
                onStopCamera={stopCamera}
                onToggleMic={handleToggleMic}
                onLayoutChange={setSelectedLayout}
                isRecording={isRecording}
                isPaused={isPaused}
                isCameraActive={isCameraOn}
                isMicActive={isMicOn}
                isScreenSharing={isScreenShared}
                canRecord={isScreenShared || isCameraOn}
                selectedLayout={selectedLayout}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
