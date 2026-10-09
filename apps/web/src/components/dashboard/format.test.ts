import { describe, expect, it } from 'vitest';
import { statusSummaryText } from './format.js';

describe('statusSummaryText', () => {
  it('says nothing when every campaign with the active status delivers', () => {
    expect(
      statusSummaryText({ withStatus: 2, delivering: 2, ended: [], notDelivering: 0 }),
    ).toBeNull();
  });

  it('names the ones that ended and the day', () => {
    expect(
      statusSummaryText({
        withStatus: 4,
        delivering: 2,
        ended: [
          { platform: 'meta', name: 'A', endDate: '2026-10-05' },
          { platform: 'meta', name: 'B', endDate: '2026-10-05' },
        ],
        notDelivering: 0,
      }),
    ).toBe('2 de 4 com status ativo; 2 encerradas em 05/10');
  });

  it('uses the singular, several days, and the ones that just do not deliver', () => {
    expect(
      statusSummaryText({
        withStatus: 3,
        delivering: 1,
        ended: [{ platform: 'google', name: 'C', endDate: '2026-10-09' }],
        notDelivering: 1,
      }),
    ).toBe('1 de 3 com status ativo; 1 encerrada em 09/10; 1 sem entregar');
    expect(
      statusSummaryText({
        withStatus: 4,
        delivering: 2,
        ended: [
          { platform: 'meta', name: 'A', endDate: '2026-10-05' },
          { platform: 'google', name: 'B', endDate: '2026-10-09' },
        ],
        notDelivering: 0,
      }),
    ).toBe('2 de 4 com status ativo; 2 encerradas em 05/10 e 09/10');
  });
});
