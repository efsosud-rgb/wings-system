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

  it("reads the ids from the platforms' UTM standard, and Meta's short source names", () => {
    const meta = rdAttributionOf({
      content: {},
      url: null,
      trafficSource: encoded({
        current_session: {
          value:
            'utm_source=ig&utm_medium=cpc&utm_campaign=120230596004630670&utm_content=120230596004640670&utm_term=120230596004620670',
        },
      }),
    });
    expect(meta).toMatchObject({
      utmSource: 'instagram',
      adPlatform: 'meta',
      adCampaignExternalId: '120230596004630670',
      adSetExternalId: '120230596004620670',
      adExternalId: '120230596004640670',
    });
    expect(
      ['msg', 'an'].map(
        (source) =>
          rdAttributionOf({
            content: {},
            url: `https://x.com/?utm_source=${source}`,
            trafficSource: null,
          })?.adPlatform,
      ),
    ).toEqual(['meta', 'meta']);

    const google = rdAttributionOf({
      content: {},
      url: 'https://x.com/?utm_source=google&utm_medium=cpc&utm_campaign=23479672774&utm_content=771234567890&utm_term=123',
      trafficSource: null,
    });
    // utm_term is Google's keyword, never an ad group.
    expect(google).toMatchObject({
      adPlatform: 'google',
      adCampaignExternalId: '23479672774',
      adSetExternalId: null,
      adExternalId: '771234567890',
    });
    // A slug in utm_campaign is not an id.
    expect(
      rdAttributionOf({
        content: {},
        url: 'https://x.com/?utm_source=facebook&utm_campaign=formatacao_set26',
        trafficSource: null,
      })?.adCampaignExternalId,
    ).toBeNull();
  });

  it('is null when the conversion carries nothing, and survives a broken traffic_source', () => {
    expect(
      rdAttributionOf({ content: {}, url: 'https://x.com/a', trafficSource: 'encoded_%%%' }),
    ).toBeNull();
  });
});
