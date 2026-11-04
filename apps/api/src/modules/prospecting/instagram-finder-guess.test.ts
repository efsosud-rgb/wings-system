import { siteDomain } from '@wings/shared';
import { describe, expect, it } from 'vitest';
import {
  cityOf,
  finderKeyOf,
  guessHandles,
  issueFinderTicket,
  nameTokens,
  ownDomainLabel,
  profileMatches,
  readFinderTicket,
} from './instagram-finder.js';

/**
 * t086 / t090: what the finder derives from a name and a site, with no database. Made-up companies
 * and @ only (the platform names are the real hosts the review found handing back their own @).
 */

const T0 = new Date('2026-11-04T15:00:00.000Z');

describe('what the finder derives from a name and a site', () => {
  it('guesses the @ from the company domain when it says the name, then the name run together', () => {
    expect(
      guessHandles({
        name: 'Padaria Central - Icaraí',
        website: 'https://www.padariacentral.com.br/',
      }),
    ).toEqual(['padariacentral']);
    expect(guessHandles({ name: 'Café & Bar do João Ltda', website: null })).toEqual([
      'cafebarjoao',
    ]);
    expect(
      guessHandles({
        name: 'Hamburgueria do João',
        website: 'https://hamburgueria-joao.com.br/contato',
      }),
    ).toEqual(['hamburgueriajoao']);
    // A shared host is not the company's word, a very short one is not a guess.
    expect(guessHandles({ name: 'Ok', website: 'https://linktr.ee/okok' })).toEqual([]);
    expect(nameTokens('Padaria Central | Niterói')).toEqual(['padaria', 'central']);
  });

  it('a domain that says nothing of the name is no guess: whose @ it is cannot be told', () => {
    // "zetashop" carries "zeta", an identifying word of the name: it is asked first.
    expect(guessHandles({ name: 'Loja Zeta', website: 'https://zetashop.example/' })).toEqual([
      'zetashop',
      'lojazeta',
    ]);
    expect(guessHandles({ name: 'Padaria Central', website: 'https://grupoabc.com.br/' })).toEqual([
      'padariacentral',
    ]);
  });

  it('never guesses from a delivery app, a marketplace or an agenda (t090)', () => {
    const platforms = [
      'https://www.rappi.com.br/restaurantes/loja-teste',
      'https://www.ubereats.com/br/store/loja-teste/abc',
      'https://www.doctoralia.com.br/clinica/teste',
      'https://shopee.com.br/loja-teste',
      'https://www.mercadolivre.com.br/loja/teste',
      'https://www.ifood.com.br/delivery/teste',
      'https://www.instagram.com/loja.teste/',
    ];
    for (const website of platforms) {
      expect(siteDomain(website), website).toBeNull();
      expect(ownDomainLabel(website), website).toBeNull();
      // Whatever the company is called, the platform's word is never among the @ tried.
      const handles = guessHandles({ name: 'Rappi Ubereats Doctoralia Shopee', website });
      expect(handles, website).toEqual(['rappiubereatsdoctoraliashopee']);
    }
    for (const website of platforms.slice(0, 5))
      expect(guessHandles({ name: 'Loja Teste', website }), website).toEqual(['lojateste']);
  });

  it('never guesses from a subdomain: its first label is a service, not the company (t090)', () => {
    for (const website of [
      'https://pedido.anota.ai/loja/teste',
      'https://loja.marcateste.com.br/',
      'https://www.cardapio.marcateste.com.br/',
      'https://app.marcateste.com/',
    ]) {
      expect(ownDomainLabel(website), website).toBeNull();
      expect(guessHandles({ name: 'Marca Teste', website }), website).toEqual(['marcateste']);
    }
    // The registrable name stays: "marcateste.com.br", "marcateste.com", with or without www.
    expect(ownDomainLabel('https://www.marcateste.com.br/')).toBe('marcateste');
    expect(ownDomainLabel('marcateste.com')).toBe('marcateste');
    expect(ownDomainLabel(null)).toBeNull();
  });

  it('takes the city out of a Google address', () => {
    expect(cityOf('Rua Fictícia, 12 - Icaraí, Niterói - RJ, 24220-000, Brasil')).toBe('Niterói');
    expect(cityOf(null)).toBeNull();
  });

  it('a web profile counts only when every identifying word of the name is in it', () => {
    expect(profileMatches('Padaria Delta', 'padariadelta.niteroi', 'Padaria Delta (@x)')).toBe(
      true,
    );
    expect(profileMatches('Padaria Delta', 'padaria_do_joao', 'Padaria do João')).toBe(false);
    expect(profileMatches('Padaria Delta', 'delta.oficial', 'Delta Oficial')).toBe(false);
    expect(profileMatches(null, 'qualquer', 'Qualquer')).toBe(false);
  });

  it('a ticket carries the company, is signed for one seller and expires', () => {
    const key = finderKeyOf('s'.repeat(48));
    const company = {
      placeId: 'ChIJx',
      name: 'Loja Zeta',
      website: null,
      address: 'Rua A, 1 - B, C - RJ',
    };
    const ticket = issueFinderTicket(key, 'seller-1', company, T0);
    expect(readFinderTicket(key, 'seller-1', ticket, T0)).toEqual(company);
    expect(readFinderTicket(key, 'seller-2', ticket, T0)).toBeNull();
    expect(readFinderTicket(finderKeyOf('o'.repeat(48)), 'seller-1', ticket, T0)).toBeNull();
    expect(readFinderTicket(key, 'seller-1', `${ticket}x`, T0)).toBeNull();
    expect(
      readFinderTicket(key, 'seller-1', ticket, new Date(T0.getTime() + 13 * 3_600_000)),
    ).toBeNull();
  });
});
