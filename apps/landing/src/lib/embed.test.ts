import { describe, expect, it } from 'vitest';
import {
  HOME_MEDIUM,
  HOME_SOURCE,
  LEAD_MESSAGE,
  SITE_ORIGINS,
  embedOptionsOf,
  PING_TYPE,
  heightMessageOf,
  isHeightPing,
  parentTargetsOf,
  robotCheckScaleOf,
  withHomeSource,
} from './embed.js';

describe('embedOptionsOf', () => {
  it('shows the title only with titulo=1', () => {
    expect(embedOptionsOf('').title).toBe(false);
    expect(embedOptionsOf('?titulo=0').title).toBe(false);
    expect(embedOptionsOf('?titulo=1').title).toBe(true);
  });

  it('keeps ref only when it is an http(s) address', () => {
    expect(embedOptionsOf('?ref=https%3A%2F%2Fwww.google.com%2F').referrer).toBe(
      'https://www.google.com/',
    );
    expect(embedOptionsOf('?ref=javascript%3Aalert(1)').referrer).toBe('');
    expect(embedOptionsOf('?ref=not-an-address').referrer).toBe('');
    expect(embedOptionsOf('').referrer).toBe('');
  });

  it('takes the page only from the Wings site', () => {
    const own = 'https://wingscompany.com.br/?utm_source=google';
    expect(embedOptionsOf(`?pagina=${encodeURIComponent(own)}`).page).toBe(own);
    expect(
      embedOptionsOf(`?pagina=${encodeURIComponent('https://www.wingscompany.com.br/')}`).page,
    ).toBe('https://www.wingscompany.com.br/');
    for (const other of [
      'https://wingscompany.com.br.evil.example/',
      'https://evil.example/https://wingscompany.com.br/',
      'http://wingscompany.com.br/',
      'javascript:alert(1)',
    ]) {
      expect(embedOptionsOf(`?pagina=${encodeURIComponent(other)}`).page).toBeNull();
    }
  });
});

describe('parentTargetsOf', () => {
  it('uses the framing origin when it is the Wings site', () => {
    expect(parentTargetsOf('https://www.wingscompany.com.br', '')).toEqual([
      'https://www.wingscompany.com.br',
    ]);
  });

  it('falls back to the referrer’s origin, then to both site origins', () => {
    expect(parentTargetsOf(undefined, 'https://wingscompany.com.br/contato/?x=1')).toEqual([
      'https://wingscompany.com.br',
    ]);
    expect(parentTargetsOf(undefined, '')).toEqual(SITE_ORIGINS);
  });

  it('never targets another origin, nor "*"', () => {
    for (const targets of [
      parentTargetsOf('https://evil.example', 'https://evil.example/'),
      parentTargetsOf(undefined, 'https://evil.example/'),
      parentTargetsOf('', ''),
    ]) {
      expect(targets).toEqual(SITE_ORIGINS);
      expect(targets).not.toContain('*');
    }
  });
});

describe('messages', () => {
  it('are the ones the site’s listener reads', () => {
    expect(LEAD_MESSAGE).toEqual({ tipo: 'wings-lead', origem: 'site-home' });
    expect(heightMessageOf(512)).toEqual({ tipo: 'wings-form-altura', altura: 512 });
  });
});

describe('withHomeSource', () => {
  it('marks a visit with no source as the home’s', () => {
    expect(withHomeSource({})).toEqual({ utm_source: HOME_SOURCE, utm_medium: HOME_MEDIUM });
    expect(withHomeSource({ referrer: 'https://www.google.com/' })).toEqual({
      referrer: 'https://www.google.com/',
      utm_source: 'site',
      utm_medium: 'formulario-home',
    });
  });

  it('keeps a visit that came with a UTM source or a click id', () => {
    const utm = { utm_source: 'google', utm_medium: 'cpc', utm_campaign: '123' };
    expect(withHomeSource(utm)).toBe(utm);
    for (const key of ['gclid', 'fbclid', 'gbraid', 'wbraid'] as const) {
      const clicked = { [key]: 'abc' };
      expect(withHomeSource(clicked)).toBe(clicked);
    }
  });
});

describe('robotCheckScaleOf', () => {
  it('is 1 when the robot check fits and shrinks to the room, never below a half', () => {
    expect(robotCheckScaleOf(300)).toBe(1);
    expect(robotCheckScaleOf(520)).toBe(1);
    expect(robotCheckScaleOf(255)).toBeCloseTo(0.85);
    expect(robotCheckScaleOf(100)).toBe(0.5);
  });
});

describe('isHeightPing', () => {
  it('accepts the ping only from the Wings site', () => {
    expect(isHeightPing(SITE_ORIGINS[0]!, { tipo: PING_TYPE })).toBe(true);
    expect(isHeightPing(SITE_ORIGINS[1]!, { tipo: PING_TYPE })).toBe(true);
    expect(isHeightPing('https://evil.example', { tipo: PING_TYPE })).toBe(false);
    expect(isHeightPing(SITE_ORIGINS[0]!, { tipo: 'outra-coisa' })).toBe(false);
    expect(isHeightPing(SITE_ORIGINS[0]!, null)).toBe(false);
    expect(isHeightPing(SITE_ORIGINS[0]!, 'wings-form-ping')).toBe(false);
  });
});
