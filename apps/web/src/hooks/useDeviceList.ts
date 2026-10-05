'use client';

import { useCallback, useEffect, useState } from 'react';

export interface DeviceOption {
    deviceId: string;
    label: string;
}

/**
 * Enumerates camera and microphone devices.
 * Labels are only populated after a permission grant, so the list is
 * refreshed on `devicechange` and can be refreshed manually once a
 * stream (and therefore permission) is active.
 */
export function useDeviceList() {
    const [cameras, setCameras] = useState<DeviceOption[]>([]);
    const [microphones, setMicrophones] = useState<DeviceOption[]>([]);

    const refresh = useCallback(async () => {
        try {
            if (!navigator.mediaDevices?.enumerateDevices) return;
            const devices = await navigator.mediaDevices.enumerateDevices();
            setCameras(
                devices
                    .filter((d) => d.kind === 'videoinput')
                    .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Camera' }))
            );
            setMicrophones(
                devices
                    .filter((d) => d.kind === 'audioinput')
                    .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }))
            );
        } catch {
            // enumerateDevices can fail before permissions exist; ignore
        }
    }, []);

    useEffect(() => {
        refresh();
        const mediaDevices = navigator.mediaDevices;
        if (!mediaDevices?.addEventListener) return;
        mediaDevices.addEventListener('devicechange', refresh);
        return () => mediaDevices.removeEventListener('devicechange', refresh);
    }, [refresh]);

    return { cameras, microphones, refresh };
}
