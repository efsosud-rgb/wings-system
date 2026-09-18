import { describe, expect, it } from 'vitest';
import { readImageInfo } from './image-info.js';

/** Header bytes only: enough to prove type and size, which is all that is read. */

function jpegOf(width: number, height: number, leading: number[] = []): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255];
  return Buffer.from([0xff, 0xd8, ...app0, ...leading, ...sof, ...new Array<number>(12).fill(0)]);
}

describe('readImageInfo', () => {
  it('reads a JPEG frame size, skipping the segments before it', () => {
    expect(readImageInfo(jpegOf(1200, 628))).toEqual({
      mimeType: 'image/jpeg',
      width: 1200,
      height: 628,
    });
    // A Huffman table (C4) sits in the SOF range but carries no size.
    const dht = [0xff, 0xc4, 0x00, 0x03, 0x00];
    expect(readImageInfo(jpegOf(1080, 1920, dht))?.height).toBe(1920);
  });

  it('refuses anything that is not PNG or JPEG', () => {
    expect(readImageInfo(Buffer.from('GIF89a' + 'x'.repeat(40)))).toBeNull();
    expect(readImageInfo(Buffer.from('%PDF-1.7' + 'x'.repeat(40)))).toBeNull();
    expect(readImageInfo(Buffer.alloc(0))).toBeNull();
    // A JPEG that ends before any frame.
    expect(readImageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]))).toBeNull();
  });
});
