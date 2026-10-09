import { describe, expect, it } from 'vitest';
import { isoDurationSeconds, parseYoutubeChannelRef, youtubeVideoLink } from './youtube-channel.js';

const ID = 'UCabcdefghijklmnopqrstuv';

describe('parseYoutubeChannelRef', () => {
  it('reads a channel id, bare or in a /channel/ link', () => {
    expect(parseYoutubeChannelRef(ID)).toEqual({ kind: 'id', id: ID });
    expect(parseYoutubeChannelRef(`https://www.youtube.com/channel/${ID}`)).toEqual({
      kind: 'id',
      id: ID,
    });
    expect(parseYoutubeChannelRef(`youtube.com/channel/${ID}/videos`)).toEqual({
      kind: 'id',
      id: ID,
    });
  });

  it('reads a handle, bare or in a link', () => {
    expect(parseYoutubeChannelRef('@wingscompany')).toEqual({
      kind: 'handle',
      handle: '@wingscompany',
    });
    expect(parseYoutubeChannelRef('https://m.youtube.com/@wings.company/shorts')).toEqual({
      kind: 'handle',
      handle: '@wings.company',
    });
  });

  it('refuses what names no channel the API can resolve', () => {
    for (const value of [
      null,
      '',
      '   ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/c/WingsCompany',
      'https://www.youtube.com/user/wings',
      `https://evil.example/channel/${ID}`,
      'https://www.youtube.com/channel/UCshort',
      'not a link at all',
    ]) {
      expect(parseYoutubeChannelRef(value)).toBeNull();
    }
  });
});

describe('isoDurationSeconds', () => {
  it('reads plain ISO 8601 durations', () => {
    expect(isoDurationSeconds('PT45S')).toBe(45);
    expect(isoDurationSeconds('PT1M5S')).toBe(65);
    expect(isoDurationSeconds('PT1H2M3S')).toBe(3723);
    expect(isoDurationSeconds('P1DT1S')).toBe(86_401);
    expect(isoDurationSeconds('P0D')).toBe(0);
  });

  it('is null for anything else', () => {
    for (const value of [null, undefined, '', 'P', 'PT', '45', 'PT1.5S', 'garbage']) {
      expect(isoDurationSeconds(value)).toBeNull();
    }
  });
});

it('links a video by id', () => {
  expect(youtubeVideoLink('dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});
