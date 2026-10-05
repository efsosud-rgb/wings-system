import { describe, expect, it } from 'vitest';
import { META_URL_TAGS } from '@wings/shared';
import { utmContentOfCreative } from './meta-parse.js';

describe('utm_content of a creative', () => {
  it('reads it from a video call to action, a link ad, a carousel card or url_tags', () => {
    expect(
      utmContentOfCreative({
        object_story_spec: {
          video_data: {
            call_to_action: {
              value: { link: 'https://x.com.br/?utm_source=facebook&utm_content=video-2' },
            },
          },
        },
      }),
    ).toBe('video-2');
    expect(
      utmContentOfCreative({
        object_story_spec: { link_data: { link: 'https://x.com.br/?utm_content=imagem-1#top' } },
      }),
    ).toBe('imagem-1');
    expect(
      utmContentOfCreative({
        object_story_spec: {
          link_data: { child_attachments: [{ link: 'https://x.com.br/?utm_content=carrossel-3' }] },
        },
      }),
    ).toBe('carrossel-3');
    expect(utmContentOfCreative({ url_tags: 'utm_source=facebook&utm_content=video-9' })).toBe(
      'video-9',
    );
  });

  it('is null for the standard url_tags, whose utm_content is the ad id Meta fills per click', () => {
    expect(
      utmContentOfCreative({
        object_story_spec: { link_data: { link: 'https://x.com.br/' } },
        url_tags: META_URL_TAGS,
      }),
    ).toBeNull();
  });

  it('is null for an ad whose link has none (the ads made before per-ad numbering)', () => {
    expect(
      utmContentOfCreative({
        object_story_spec: {
          video_data: {
            call_to_action: {
              value: {
                link: 'https://wingscompany.com.br/contato/?utm_source=facebook&utm_medium=cpc',
              },
            },
          },
        },
      }),
    ).toBeNull();
  });
});
