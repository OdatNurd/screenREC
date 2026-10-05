/**
 * Save a recording to disk under the filename chosen in the Save Recording
 * dialog.
 *
 * Downloads straight to the browser's download folder — the same behavior for
 * WebM and MP4. (A showSaveFilePicker prompt would be inconsistent between the
 * formats: the picker requires fresh user activation, which the MP4 path loses
 * while waiting for server conversion, so only WebM used to prompt.)
 */

export async function saveBlob(blob: Blob, filename: string): Promise<boolean> {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return true;
}
