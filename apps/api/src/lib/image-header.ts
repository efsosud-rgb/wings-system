/**
 * The type and size of a PNG or JPEG, read from its first bytes by hand (no
 * image library): the type by the file's signature, never by its name or by
 * what the browser said, and the width and height from the PNG's IHDR chunk
 * or the JPEG's start-of-frame segment. Null when it is neither, or when the
 * header is cut or malformed.
 */

export interface ImageHeader {
  type: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Start-of-frame markers (baseline, progressive, lossless...); not DHT (C4), JPG (C8) or DAC (CC). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length >= 24 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return png(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return jpeg(bytes);
  return null;
}

const u32 = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;

function png(bytes: Uint8Array): ImageHeader | null {
  // The first chunk is IHDR, 13 bytes long: width and height, 4 bytes each.
  if (u32(bytes, 8) !== 13) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  return width > 0 && height > 0 ? { type: 'image/png', width, height } : null;
}

function jpeg(bytes: Uint8Array): ImageHeader | null {
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Markers with no length: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // The image data or its end came before any frame header.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = u16(bytes, at + 2);
    if (length < 2) return null;
    if (SOF.has(marker)) {
      if (at + 9 > bytes.length) return null;
      const height = u16(bytes, at + 5);
      const width = u16(bytes, at + 7);
      return width > 0 && height > 0 ? { type: 'image/jpeg', width, height } : null;
    }
    at += 2 + length;
  }
  return null;
}
