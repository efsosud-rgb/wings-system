import { describe, expect, it } from 'vitest';
import { fakeJpeg, fakePng } from '../test/factories.js';
import { readImageHeader } from './image-header.js';

describe('readImageHeader', () => {
  it('reads a PNG and a JPEG by their bytes', () => {
    expect(readImageHeader(fakePng(1125, 600))).toEqual({
      type: 'image/png',
      width: 1125,
      height: 600,
    });
    expect(readImageHeader(fakeJpeg(1125, 600))).toEqual({
      type: 'image/jpeg',
      width: 1125,
      height: 600,
    });
    expect(readImageHeader(fakeJpeg(600, 1125))).toMatchObject({ width: 600, height: 1125 });
  });

  it('skips fill bytes and segments before the JPEG frame header', () => {
    const jpeg = fakeJpeg(800, 400);
    // A comment segment (COM) and fill bytes before the frame.
    const comment = Buffer.from([0xff, 0xff, 0xfe, 0x00, 0x05, 0x61, 0x62, 0x63]);
    const withComment = Buffer.concat([jpeg.subarray(0, 20), comment, jpeg.subarray(20)]);
    expect(readImageHeader(withComment)).toMatchObject({ width: 800, height: 400 });
  });

  it('refuses anything else, a cut header, or a JPEG with no frame before its data', () => {
    expect(readImageHeader(Buffer.from('GIF89a........................'))).toBeNull();
    expect(readImageHeader(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(readImageHeader(fakePng(1125, 600).subarray(0, 20))).toBeNull();
    expect(readImageHeader(fakeJpeg(1125, 600).subarray(0, 24))).toBeNull();
    const noFrame = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]);
    expect(readImageHeader(noFrame)).toBeNull();
    expect(readImageHeader(fakePng(0, 600))).toBeNull();
    expect(readImageHeader(Buffer.alloc(0))).toBeNull();
  });
});
