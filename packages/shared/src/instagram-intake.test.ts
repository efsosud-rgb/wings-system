import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRIVATE_REPLY_SETTINGS,
  privateReplyChangeDenial,
  privateReplyDeadline,
  privateReplyText,
  repliesAlone,
} from './instagram-intake.js';
import {
  DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS,
  instagramProspectingSettingsSchema,
} from './prospect-ai.js';

const auto = { ...DEFAULT_PRIVATE_REPLY_SETTINGS, modo: 'automatico' as const };

describe('the private reply (docs/prospeccao/instagram.md §5.2 to §5.4)', () => {
  it('is off by default, and a row saved before parte 1 reads the defaults', () => {
    expect(DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS.privateReply.modo).toBe('desligado');
    const older: Partial<typeof DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS> = {
      ...DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS,
    };
    delete older.privateReply;
    const parsed = instagramProspectingSettingsSchema.parse(older);
    expect(parsed.privateReply).toEqual(DEFAULT_PRIVATE_REPLY_SETTINGS);
  });

  it('needs {link_politica} in the text, and leaves nothing without the policy link', () => {
    expect(
      instagramProspectingSettingsSchema.safeParse({
        ...DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS,
        privateReply: { ...auto, texto: 'Oi! Um texto sem o link da política, longo o bastante.' },
      }).success,
    ).toBe(false);
    expect(privateReplyText(auto, null, false)).toBeNull();
    const text = privateReplyText(auto, 'https://exemplo.com/privacidade', false)!;
    expect(text).toContain('Privacidade: https://exemplo.com/privacidade');
    expect(text).toContain('no nosso post');
    expect(privateReplyText(auto, 'https://exemplo.com/privacidade', true)).toContain(
      'no nosso anúncio',
    );
  });

  it('goes alone only in automatico, for a buying signal at or above the threshold', () => {
    expect(repliesAlone(auto, 'pediu_preco', 85)).toBe(true);
    expect(repliesAlone(auto, 'quer_comprar', 84)).toBe(false);
    expect(repliesAlone(auto, 'duvida', 99)).toBe(false);
    expect(repliesAlone(auto, 'quer_comprar', null)).toBe(false);
    expect(repliesAlone({ ...auto, modo: 'clique' }, 'quer_comprar', 99)).toBe(false);
  });

  it("stops one hour before Meta's 7 days", () => {
    const at = new Date('2026-10-25T12:00:00Z');
    expect(privateReplyDeadline(at).toISOString()).toBe('2026-11-01T11:00:00.000Z');
  });

  it("turning it on alone, lowering its threshold or changing its text is the Admin Master's", () => {
    const click = { ...DEFAULT_PRIVATE_REPLY_SETTINGS, modo: 'clique' as const };
    expect(privateReplyChangeDenial(click, auto, false)).toMatch(/liga/);
    expect(privateReplyChangeDenial(auto, { ...auto, confiancaAutomatica: 80 }, false)).toMatch(
      /baixa/,
    );
    expect(
      privateReplyChangeDenial(click, { ...click, texto: `${click.texto} ` + 'x' }, false),
    ).toMatch(/texto/);
    expect(privateReplyChangeDenial(auto, click, false)).toBeNull();
    expect(privateReplyChangeDenial(click, { ...click, modo: 'desligado' }, false)).toBeNull();
    expect(privateReplyChangeDenial(click, auto, true)).toBeNull();
  });
});
