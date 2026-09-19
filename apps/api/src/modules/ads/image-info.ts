/**
 * Reads type and dimensions from the bytes of an image.
 *
 * The upload route trusts nothing the browser says about a file: not the
 * Content-Type, not the dimensions. What is stored is what these few header
 * bytes prove. PNG, JPEG and WebP are recognised; each caller says which of
 * them it accepts (ad creatives take no WebP). Anything else, including a
 * renamed file, is refused.
 */

export interface ImageInfo {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { mimeType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readJpeg(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    // Padding and markers that carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }

    const length = bytes.readUInt16BE(offset + 2);
    // SOF0–SOF15 hold the frame size; C4, C8 and CC share the range but do not.
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return {
        mimeType: 'image/jpeg',
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * WebP is a RIFF container whose first chunk says which of three encodings
 * follows, and each keeps the canvas size somewhere else.
 */
function readWebp(bytes: Buffer): ImageInfo | null {
  if (bytes.length < 30) return null;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  const chunk = bytes.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    // Extended: 24-bit little-endian width-1 and height-1.
    return {
      mimeType: 'image/webp',
      width: bytes.readUIntLE(24, 3) + 1,
      height: bytes.readUIntLE(27, 3) + 1,
    };
  }
  if (chunk === 'VP8L') {
    // Lossless: a 0x2f signature, then 14 bits of width-1 and 14 of height-1.
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes.readUInt32LE(21);
    return {
      mimeType: 'image/webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === 'VP8 ') {
    // Lossy: a 3-byte frame tag, the start code 9d 01 2a, then two 14-bit sizes.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      mimeType: 'image/webp',
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

export function readImageInfo(bytes: Buffer): ImageInfo | null {
  const info = readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
  if (!info || info.width <= 0 || info.height <= 0) return null;
  return info;
}
