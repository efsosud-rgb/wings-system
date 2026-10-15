import { describe, expect, it } from 'vitest';
import {
  EMPTY_INSTAGRAM_STEPS,
  effectiveInstagramVerdict,
  instagramCheckLabelOf,
  instagramProfileUrl,
  instagramVerdictOf,
  type InstagramCheckSteps,
  type LeadInstagramCheck,
} from './instagram-check.js';
import {
  FORM_REF_LENGTH,
  generateFormRef,
  trackedLinkText,
  trackingRefOf,
  whatsappLinkOf,
} from './leads.js';

const steps = (over: Partial<InstagramCheckSteps>): InstagramCheckSteps => ({
  ...EMPTY_INSTAGRAM_STEPS,
  ...over,
});

describe('suspect or fake', () => {
  it('is fake only when Meta and the search both looked and found nothing', () => {
    expect(
      instagramVerdictOf('nao_encontrado', steps({ meta: 'not_found', search: 'not_found' })),
    ).toBe('falso');
    expect(
      instagramVerdictOf('nao_encontrado', steps({ meta: 'not_found', search: 'skipped' })),
    ).toBe('suspeito');
    expect(
      instagramVerdictOf('nao_encontrado', steps({ meta: 'error', search: 'not_found' })),
    ).toBe('suspeito');
    expect(instagramVerdictOf('nao_encontrado', steps({ format: 'invalid' }))).toBe('suspeito');
  });

  it('counts nothing for a profile that was found, does not match, failed or is waiting', () => {
    for (const status of ['confere', 'nao_bate', 'erro', 'pendente'] as const) {
      expect(
        instagramVerdictOf(status, steps({ meta: 'not_found', search: 'not_found' })),
      ).toBeNull();
    }
  });

  it("lets a person's correction win over the machine, both ways", () => {
    expect(effectiveInstagramVerdict('suspeito', 'falso')).toBe('falso');
    expect(effectiveInstagramVerdict('falso', 'confere')).toBeNull();
    expect(effectiveInstagramVerdict('suspeito', null)).toBe('suspeito');
    expect(effectiveInstagramVerdict(null, null)).toBeNull();
  });
});

describe('the words on the deal page', () => {
  const check = (over: Partial<LeadInstagramCheck>): LeadInstagramCheck => ({
    status: 'confere',
    source: 'meta',
    checkedAt: null,
    reason: null,
    steps: null,
    followers: null,
    posts: null,
    verdict: null,
    manual: null,
    effectiveVerdict: null,
    profileUrl: null,
    ...over,
  });
  it("says each state in the team's words", () => {
    expect(instagramCheckLabelOf(check({}))).toBe('Confere');
    expect(instagramCheckLabelOf(check({ status: 'nao_bate' }))).toBe('Não bate com a empresa');
    expect(instagramCheckLabelOf(check({ status: 'nao_encontrado', verdict: 'suspeito' }))).toBe(
      'Não encontrado · suspeito',
    );
    expect(instagramCheckLabelOf(check({ status: 'nao_encontrado', verdict: 'falso' }))).toBe(
      'Falso',
    );
    expect(instagramCheckLabelOf(check({ status: 'pendente' }))).toBe('Conferindo…');
    expect(instagramCheckLabelOf(check({ status: 'erro' }))).toBe('Não conferido');
    expect(
      instagramCheckLabelOf(
        check({ status: 'nao_encontrado', manual: { verdict: 'confere', at: 'x' } }),
      ),
    ).toMatch(/Confere/);
    expect(instagramCheckLabelOf(check({ manual: { verdict: 'falso', at: 'x' } }))).toMatch(
      /Falso/,
    );
  });

  it('links only a real handle', () => {
    expect(instagramProfileUrl('@Padaria.Aurora')).toBe(
      'https://www.instagram.com/padaria.aurora/',
    );
    expect(instagramProfileUrl('instagram.com/aurora/')).toBe('https://www.instagram.com/aurora/');
    expect(instagramProfileUrl('não tenho')).toBeNull();
    expect(instagramProfileUrl(null)).toBeNull();
  });
});

describe('the form ref in the WhatsApp text', () => {
  it('makes six characters of the code alphabet, never 0, O, 1 or I', () => {
    const ref = generateFormRef(() => 0.5);
    expect(ref).toHaveLength(FORM_REF_LENGTH);
    for (let i = 0; i < 200; i++) expect(generateFormRef()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it('writes <code> <ref> and reads the ref back only after a tracking code', () => {
    expect(trackedLinkText('K7M2QX', null, 'ABC234')).toBe('K7M2QX ABC234');
    expect(trackedLinkText('K7M2QX', 'Aurora', 'ABC234')).toBe(
      'K7M2QX ABC234 Olá! Quero saber sobre a franquia Aurora.',
    );
    expect(trackedLinkText('K7M2QX', 'Aurora')).toBe(
      'K7M2QX Olá! Quero saber sobre a franquia Aurora.',
    );
    expect(whatsappLinkOf('5521999470288', 'K7M2QX', null, 'ABC234')).toBe(
      `https://wa.me/5521999470288?text=${encodeURIComponent('K7M2QX ABC234')}`,
    );
    expect(trackingRefOf('K7M2QX abc234 Olá!')).toBe('ABC234');
    expect(trackingRefOf('#K7M2QX ABC234')).toBe('ABC234');
    expect(trackingRefOf('K7M2QX Olá! Quero saber')).toBeNull();
    expect(trackingRefOf('ABC234 K7M2QX')).toBe('K7M2QX');
    expect(trackingRefOf('Olá ABC234')).toBeNull();
    expect(trackingRefOf(null)).toBeNull();
  });
});
