import { describe, expect, it } from 'vitest';
import {
  parseWingsDriveRef,
  segmentsByZone,
  segmentsToSrt,
  wingsDriveRef,
  zoneSrtName,
} from './studio.js';

describe('segmentsToSrt', () => {
  it('numbers the cues, writes HH:MM:SS,mmm and skips empty text', () => {
    const srt = segmentsToSrt([
      { start: 0, end: 1.5, text: ' Olá ' },
      { start: 1.5, end: 3, text: '   ' },
      { start: 3661.25, end: 3662, text: 'Fim' },
    ]);
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nOlá\n\n2\n01:01:01,250 --> 01:01:02,000\nFim\n',
    );
  });

  it('never lets a cue end before it started', () => {
    const srt = segmentsToSrt([{ start: 2, end: 1.9, text: 'x' }]);
    expect(srt).toContain('00:00:02,000 --> 00:00:02,500');
  });
});

describe('wings-drive references', () => {
  it('round-trips a file id and refuses anything else', () => {
    const id = '5b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3';
    expect(parseWingsDriveRef(wingsDriveRef(id))).toBe(id);
    expect(parseWingsDriveRef('https://example.com/a.mp4')).toBeNull();
    expect(parseWingsDriveRef('wings-drive://not-an-id')).toBeNull();
  });
});

describe('smart captions', () => {
  it('splits the segments by zone, in preference order, dropping empty ones', () => {
    const segments = [
      { start: 0, end: 1, text: 'a' },
      { start: 1, end: 2, text: 'b' },
      { start: 2, end: 3, text: ' ' },
      { start: 3, end: 4, text: 'c' },
    ];
    const groups = segmentsByZone(segments, ['top', 'bottom', 'middle', 'top']);
    expect(groups.map((group) => [group.zone, group.segments.map((item) => item.text)])).toEqual([
      ['bottom', ['b']],
      ['top', ['a', 'c']],
    ]);
  });

  it('puts a segment with no zone at the bottom', () => {
    expect(segmentsByZone([{ start: 0, end: 1, text: 'a' }], [])[0]?.zone).toBe('bottom');
  });

  it('names one SRT per zone next to the plain one', () => {
    expect(zoneSrtName('entrevista.srt', 'top')).toBe('entrevista.legenda-em-cima.srt');
    expect(zoneSrtName('entrevista.SRT', 'bottom')).toBe('entrevista.legenda-embaixo.srt');
    expect(zoneSrtName('entrevista.srt', 'middle')).toBe('entrevista.legenda-no-meio.srt');
  });
});
