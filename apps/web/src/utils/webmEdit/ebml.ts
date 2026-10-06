/**
 * Minimal EBML (Matroska/WebM) reader/writer primitives.
 *
 * Only what the edit engine needs: variable-size integers, element header
 * parsing against a Blob without loading it fully into memory, and small
 * element encoders for the rebuilt output file.
 */

/** EBML/Matroska element IDs used by the engine. */
export const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  MUXING_APP: 0x4d80,
  WRITING_APP: 0x5741,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,
  AUDIO: 0xe1,
  SAMPLING_FREQUENCY: 0xb5,
  CHANNELS: 0x9f,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  REFERENCE_BLOCK: 0xfb,
  CUES: 0x1c53bb6b,
  CUE_POINT: 0xbb,
  CUE_TIME: 0xb3,
  CUE_TRACK_POSITIONS: 0xb7,
  CUE_TRACK: 0xf7,
  CUE_CLUSTER_POSITION: 0xf1,
} as const;

export interface VInt {
  /** Numeric value (for element IDs the marker bits are retained). */
  value: number;
  /** Number of bytes consumed. */
  length: number;
}

/**
 * Parse an EBML variable-size integer at `pos`.
 * With `keepMarker` the leading length-marker bits stay part of the value
 * (element IDs); without it they are stripped (element sizes).
 * Returns null when the VINT is all-ones ("unknown size").
 */
export function parseVint(
  buf: Uint8Array,
  pos: number,
  keepMarker: boolean
): VInt | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  if (first === 0) return null; // invalid: no length marker
  // Length is encoded in the position of the highest set bit.
  const length = 8 - Math.floor(Math.log2(first));
  if (length > 8 || pos + length > buf.length) return null;

  const markerBit = 0x80 >> (length - 1);
  let value = keepMarker ? first : first & (markerBit - 1);
  let allOnes = (first & (markerBit - 1)) === markerBit - 1;
  for (let i = 1; i < length; i++) {
    const b = buf[pos + i];
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }
  if (!keepMarker && allOnes) return null; // unknown size
  return { value, length };
}

/** Encode `value` as a size-style VINT (marker bit set, minimal length). */
export function encodeVint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`encodeVint: bad value ${value}`);
  }
  for (let length = 1; length <= 8; length++) {
    const max = Math.pow(2, 7 * length) - 1;
    if (value >= max) continue; // all-ones pattern is reserved for "unknown"
    const out = new Uint8Array(length);
    let v = value;
    for (let i = length - 1; i >= 0; i--) {
      out[i] = v & 0xff;
      v = Math.floor(v / 256);
    }
    // Length marker = highest-set-bit pattern: 0x80 >> (length - 1).
    out[0] |= 0x80 >> (length - 1);
    return out;
  }
  throw new Error(`encodeVint: value ${value} too large`);
}

/** Encode an element ID (value already includes its marker bits). */
export function encodeId(id: number): Uint8Array {
  const bytes: number[] = [];
  let v = id;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Uint8Array.from(bytes);
}

/** Encode an unsigned integer element payload (minimal big-endian width). */
function encodeUintPayload(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = Math.max(0, Math.round(value));
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return Uint8Array.from(bytes);
}

/** Byte length of a Uint8Array or Blob part. */
export function partSize(part: Uint8Array | Blob): number {
  return part instanceof Blob ? part.size : part.length;
}

/** Concatenate Uint8Array/Blob parts (Blobs are kept zero-copy). */
export function concatParts(parts: (Uint8Array | Blob)[]): Uint8Array | Blob {
  const hasBlob = parts.some((p) => p instanceof Blob);
  if (hasBlob) return new Blob(parts as BlobPart[]);
  const total = parts.reduce((n, p) => n + (p as Uint8Array).length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p as Uint8Array, pos);
    pos += (p as Uint8Array).length;
  }
  return out;
}

/** Encode an EBML element with raw payload bytes. */
export function element(id: number, payload: Uint8Array | Blob): Uint8Array | Blob {
  const idBytes = encodeId(id);
  const sizeBytes = encodeVint(partSize(payload));
  return concatParts([idBytes, sizeBytes, payload]);
}

/** Encode an EBML element whose payload is always small bytes. */
function elementBytes(id: number, payload: Uint8Array): Uint8Array {
  const idBytes = encodeId(id);
  const sizeBytes = encodeVint(payload.length);
  const out = new Uint8Array(idBytes.length + sizeBytes.length + payload.length);
  out.set(idBytes, 0);
  out.set(sizeBytes, idBytes.length);
  out.set(payload, idBytes.length + sizeBytes.length);
  return out;
}

/** Encode an unsigned-integer element. */
export function uintElement(id: number, value: number): Uint8Array {
  return elementBytes(id, encodeUintPayload(value));
}

/** Encode a float element (8-byte double). */
export function floatElement(id: number, value: number): Uint8Array {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setFloat64(0, value, false);
  return elementBytes(id, payload);
}

/** Encode an ASCII string element (no trailing NUL). */
export function stringElement(id: number, value: string): Uint8Array {
  return elementBytes(id, new TextEncoder().encode(value));
}

/**
 * Parse a size VINT, preserving the distinction between "unknown size"
 * (all value bits set — Chrome uses this for streamed Segments) and invalid.
 * The marker bit is stripped before arithmetic: keeping it would overflow
 * the exact-integer range of a double for 8-byte VINTs.
 */
export function parseSizeVint(
  buf: Uint8Array,
  pos: number,
  allowUnknown = true
): { value: number | null; length: number } | null {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  if (first === 0) return null; // invalid: no length marker
  const length = 8 - Math.floor(Math.log2(first));
  if (length > 8 || pos + length > buf.length) return null;
  const markerBit = 0x80 >> (length - 1);
  // All value bits set encodes "unknown size" — but that byte pattern is
  // identical to a maximal legitimate size (e.g. a 127-byte block is `ff`).
  // Unknown size is only valid for Segment/Cluster; anywhere below, decode
  // it as the maximal value.
  let allOnes = (first & (markerBit - 1)) === markerBit - 1;
  for (let i = 1; i < length; i++) {
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  if (allOnes) {
    return allowUnknown
      ? { value: null, length }
      : { value: Math.pow(2, 7 * length) - 1, length }; // maximal real size
  }
  const v = parseVint(buf, pos, false);
  return v ? { value: v.value, length: v.length } : null;
}

export interface ElementHeader {
  id: number;
  /** Payload size, or null when the element uses an "unknown size". */
  size: number | null;
  /** Offset of the first payload byte. */
  bodyStart: number;
  /** Offset one past the payload (== blob end for unknown-size elements). */
  bodyEnd: number;
  /** Offset one past the whole element. */
  nextOffset: number;
}

/**
 * Read an EBML element header at absolute `offset` from a Blob, fetching only
 * the few bytes needed. `end` bounds elements with unknown size.
 */
export async function readElementHeader(
  blob: Blob,
  offset: number,
  end: number,
  unknownSizeOk = true
): Promise<ElementHeader | null> {
  const probeLen = Math.min(16, end - offset);
  if (probeLen < 2) return null;
  const probe = new Uint8Array(
    await blob.slice(offset, offset + probeLen).arrayBuffer()
  );

  const idV = parseVint(probe, 0, true);
  if (!idV) return null;
  const sizeV = parseSizeVint(probe, idV.length, unknownSizeOk);
  if (!sizeV) return null;

  const bodyStart = offset + idV.length + sizeV.length;
  const size = sizeV.value; // null = unknown size (body extends to `end`)
  const bodyEnd = size === null ? end : Math.min(end, bodyStart + size);
  return {
    id: idV.value,
    size,
    bodyStart,
    bodyEnd,
    nextOffset: bodyEnd,
  };
}
