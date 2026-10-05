/**
 * Recording storage
 *
 * Spools MediaRecorder chunks to the Origin Private File System — a real temp
 * file on disk — so the JS heap stays flat for recordings of any length.
 * Falls back to in-memory Blob accumulation where OPFS is unavailable
 * (older Safari / Firefox private mode).
 *
 * In Chromium, the Blob returned by finish() is a disk-backed File: object
 * URLs and uploads stream from it without materializing the bytes in JS
 * memory.
 *
 * Ownership lifecycle (important):
 * - While recording, the sink owns its temp file; discard() aborts and deletes it.
 * - After finish() resolves, the returned Blob OWNS the file. The file must
 *   stay on disk until the UI drops the recording and the sink is explicitly
 *   discarded. Deleting it earlier leaves a zombie Blob: its size metadata
 *   survives but every read throws NotFoundError (empty player, zero-byte
 *   download, failed upload).
 *
 * File naming: chunks land in recording-*.tmp; finish() renames the file to
 * *.rec where move() is supported, so live recordings can't be confused with
 * crash leftovers, which are swept once they are older than a day.
 */

export type StorageBackend = 'opfs' | 'memory';
export type StorageMode = 'auto' | 'opfs' | 'memory';

export interface RecordingResult {
    /** Disk-backed File when OPFS is in use; plain Blob with the in-memory fallback. */
    blob: Blob;
    size: number;
}

export interface RecordingSink {
    /** Where chunks are actually stored (after any fallback). */
    backend: StorageBackend;
    /** Queue one recorded chunk for storage. Safe to call after finish/discard (no-op). */
    write: (chunk: Blob) => void;
    /** Finalize and return the stored recording. */
    finish: () => Promise<RecordingResult>;
    /**
     * Release storage (delete the stored file / drop chunks). Safe to call more
     * than once. Only call once the UI has dropped the recording returned by
     * finish() — see the ownership notes above.
     */
    discard: () => Promise<void>;
}

const OPFS_DIR = 'screenrec';
/** Orphaned files from crashed sessions are swept once older than this. */
const STALE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * True when the blob's backing data can still be read. A blob whose OPFS file
 * was deleted keeps a stale size but fails every read — check this before
 * trusting a recording for download/upload so the user gets an honest error
 * instead of a zero-byte file or a bogus "API unreachable".
 */
export async function isBlobReadable(blob: Blob): Promise<boolean> {
    try {
        await blob.slice(0, 1).arrayBuffer();
        return true;
    } catch {
        return false;
    }
}

async function isOpfsAvailable(): Promise<boolean> {
    try {
        return typeof navigator !== 'undefined' &&
            !!navigator.storage?.getDirectory &&
            !!(await navigator.storage.getDirectory());
    } catch {
        return false;
    }
}

/**
 * Create a sink for one recording.
 *
 * mode 'auto'   — prefer OPFS (disk), fall back to RAM.
 * mode 'opfs'   — force OPFS; degrades to RAM where OPFS is unavailable
 *                 (the sink always reports where data actually went).
 * mode 'memory' — force the in-memory path (for testing parity).
 */
export async function createRecordingSink(
    mimeType: string,
    mode: StorageMode = 'auto'
): Promise<RecordingSink> {
    if (mode !== 'memory' && await isOpfsAvailable()) {
        try {
            return await createOpfsSink(mimeType);
        } catch {
            // OPFS present but unusable (quota, permissions) -> in-memory
        }
    }
    return createMemorySink(mimeType);
}

/** FileSystemFileHandle.move() is newer than the TS DOM lib; probe at runtime. */
type MovableFileHandle = FileSystemFileHandle & { move?: (name: string) => Promise<void> };

type DirEntries = { entries(): AsyncIterable<[string, FileSystemHandle]> };

async function sweepStaleEntries(dir: FileSystemDirectoryHandle): Promise<void> {
    const cutoff = Date.now() - STALE_AGE_MS;
    try {
        for await (const [name, handle] of (dir as unknown as DirEntries).entries()) {
            if (handle.kind !== 'file') continue;
            try {
                const file = await (handle as FileSystemFileHandle).getFile();
                if (file.lastModified < cutoff) {
                    await dir.removeEntry(name);
                }
            } catch { /* entry busy or unreadable — skip */ }
        }
    } catch { /* iteration unsupported — skip sweep */ }
}

async function createOpfsSink(mimeType: string): Promise<RecordingSink> {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
    // Best-effort hygiene for crashed sessions; never blocks recording start.
    void sweepStaleEntries(dir);

    const base = `recording-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fileName = `${base}.tmp`;
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();

    // Chunks arrive from ondataavailable faster than they may flush; serialize
    // writes so a single recording is stored as one contiguous stream.
    let queue: Promise<void> = Promise.resolve();
    let writeError: Error | null = null;
    let closed = false;

    const write = (chunk: Blob) => {
        if (closed || chunk.size === 0) return;
        queue = queue.then(() => writable.write(chunk)).catch((err) => {
            writeError = err instanceof Error ? err : new Error(String(err));
        });
    };

    const finish = async (): Promise<RecordingResult> => {
        if (closed) throw new Error('Recording sink already closed');
        closed = true;
        await queue;
        if (writeError) {
            await writable.abort().catch(() => { /* ignore */ });
            await dir.removeEntry(fileName).catch(() => { /* ignore */ });
            throw writeError;
        }
        await writable.close();
        // Rename to *.rec (where supported) so the stale sweep can never touch a
        // finished recording that a blob still references.
        const movable = handle as MovableFileHandle;
        if (typeof movable.move === 'function') {
            try { await movable.move(`${base}.rec`); } catch { /* keep .tmp name */ }
        }
        const file = await handle.getFile();
        // Wrap (reference, not copy) to attach the recording's MIME type:
        // the file's data stays on disk-backed storage in Chromium.
        const blob = new Blob([file], { type: mimeType });
        return { blob, size: file.size };
    };

    const discard = async () => {
        closed = true;
        await queue.catch(() => { /* ignore */ });
        await writable.abort().catch(() => { /* ignore */ });
        // Remove whichever name the file ended up with.
        for (const name of [`${base}.rec`, fileName]) {
            await dir.removeEntry(name).catch(() => { /* ignore */ });
        }
    };

    return { backend: 'opfs', write, finish, discard };
}

function createMemorySink(mimeType: string): RecordingSink {
    const chunks: Blob[] = [];
    let size = 0;
    let closed = false;

    return {
        backend: 'memory',
        write(chunk) {
            if (closed || chunk.size === 0) return;
            chunks.push(chunk);
            size += chunk.size;
        },
        async finish() {
            closed = true;
            const blob = new Blob(chunks, { type: mimeType });
            chunks.length = 0;
            return { blob, size: blob.size || size };
        },
        async discard() {
            closed = true;
            chunks.length = 0;
            size = 0;
        },
    };
}
