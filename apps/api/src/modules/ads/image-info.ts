/**
 * Reads type and dimensions from the bytes of an image.
 *
 * The upload route trusts nothing the browser says about a file: not the
 * Content-Type, not the dimensions. What is stored is what these few header
 * bytes prove. Only PNG and JPEG are accepted — the formats Meta takes for
 * image ads — and anything else, including a renamed file, is refused.
 */

export interface ImageInfo {
  mimeType: 'image/png' | 'image/jpeg';
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

export function readImageInfo(bytes: Buffer): ImageInfo | null {
  const info = readPng(bytes) ?? readJpeg(bytes);
  if (!info || info.width <= 0 || info.height <= 0) return null;
  return info;
}
