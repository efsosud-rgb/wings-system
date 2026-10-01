import { describe, expect, it } from 'vitest';
import { rdAttributionOf } from './rd-attribution.js';

const encoded = (value: unknown) =>
  `encoded_${Buffer.from(JSON.stringify(value)).toString('base64')}`;

describe('rdAttributionOf', () => {
  it('reads hidden form fields first, then the page address, then the RD session', () => {
    const attribution = rdAttributionOf({
      content: { cf_utm_source: 'facebook', utm_campaign: 'lp_cenoritas', email: 'x@y.com' },
      url: 'https://lp.exemplo.com.br/cenoritas?utm_campaign=outra&utm_medium=cpc&fbclid=IwAR1&ad_id=120200000001',
      trafficSource: encoded({
        current_session: {
          value: 'https://lp.exemplo.com.br/cenoritas?utm_content=video_1&adset_id=120200000002',
          referrer: 'https://l.instagram.com/?u=segredo',
        },
      }),
    });
    expect(attribution).toEqual({
      utmSource: 'facebook',
      utmMedium: 'cpc',
      utmCampaign: 'lp_cenoritas',
      utmContent: 'video_1',
      utmTerm: null,
      gclid: null,
      fbclid: 'IwAR1',
      gbraid: null,
      wbraid: null,
      adPlatform: 'meta',
      adCampaignExternalId: null,
      adSetExternalId: '120200000002',
      adExternalId: '120200000001',
      referrer: 'https://l.instagram.com/',
    });
  });

  it('knows Google by its click ids and keeps unfilled templates out of the ad ids', () => {
    const attribution = rdAttributionOf({
      content: {},
      url: null,
      trafficSource: encoded({
        current_session: { value: '(direct)' },
        first_session: {
          value:
            'https://franquia.exemplo.com.br/x?gclid=Cj0K&gad_campaignid=22001&ad_id={{ad.id}}',
        },
      }),
    });
    expect(attribution).toMatchObject({
      gclid: 'Cj0K',
      adPlatform: 'google',
      adCampaignExternalId: '22001',
      adExternalId: null,
      referrer: null,
    });
  });

  it('is null when the conversion carries nothing, and survives a broken traffic_source', () => {
    expect(
      rdAttributionOf({ content: {}, url: 'https://x.com/a', trafficSource: 'encoded_%%%' }),
    ).toBeNull();
  });
});
