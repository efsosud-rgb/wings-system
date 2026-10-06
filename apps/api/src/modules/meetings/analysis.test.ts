import { describe, expect, it } from 'vitest';
import { transcriptText } from './analysis.js';

describe('transcriptText', () => {
  it('drops numbers as whisper writes them (CPF, phone), keeps money, dates and counts', () => {
    const text = transcriptText([
      { start: 0, end: 4, speaker: 'S1', text: 'Meu CPF é 123 456 789 09.' },
      { start: 4, end: 8, speaker: 'S1', text: 'Me chama no 21 99876 5432.' },
      {
        start: 8,
        end: 12,
        speaker: 'S2',
        text: 'O investimento é R$ 350.000 em 2026, com 15 lojas.',
      },
    ]);
    expect(text).not.toMatch(/123|99876|5432/);
    expect(text).toContain('[número]');
    expect(text).toContain('R$ 350.000 em 2026, com 15 lojas');
  });
});
