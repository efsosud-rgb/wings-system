import { WINGS_CLIENT_ID } from '@wings/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { adAccounts, adAds, adCampaigns, adSets } from '../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { answersOfDeal } from './rd-import.js';
import { loadLead, upsertLead } from './service.js';
import { rdAnswersOf, rdConversionsOf } from './webhooks.js';

/**
 * The lead's full origin (orchestrator, 13/10): the ad, set and campaign by
 * the ids the lead keeps; RD's origin label and form; the form's answers from
 * the RD conversion and from the RD CRM deal's custom fields. Made-up data.
 */

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

describe('the RD conversion', () => {
  it('reads the answers, the company, Instagram, site, city and the origin label', () => {
    const [conversion] = rdConversionsOf({
      leads: [
        {
          uuid: 'c-1',
          email: 'pessoa.teste@exemplo.com',
          custom_fields: { cf_observacoes: 'Quero saber o prazo' },
          last_conversion: {
            content: {
              identificador: 'formatar-franquia',
              cf_investimento_disponivel_para_franquia_75_a_100_mil: 'Sim',
              company: 'Empresa Exemplo',
              cf_instagram: '@empresaexemplo',
              website: 'empresaexemplo.com.br',
              city: 'Niterói',
            },
            conversion_origin: { source: 'Tráfego Direto' },
          },
        },
      ],
    });
    expect(conversion).toMatchObject({
      identifier: 'formatar-franquia',
      trafficSource: 'Tráfego Direto',
      answers: { 'Investimento disponível': 'Sim', Observações: 'Quero saber o prazo' },
      fields: {
        companyName: 'Empresa Exemplo',
        instagram: '@empresaexemplo',
        website: 'empresaexemplo.com.br',
      },
      city: 'Niterói',
    });
  });

  it('says nothing it did not get', () => {
    expect(rdAnswersOf({}, {})).toEqual({ answers: null, fields: {}, city: null });
  });
});

describe('the RD CRM deal', () => {
  it('reads investment, notes, brand name and OBS by the custom field label', () => {
    expect(
      answersOfDeal({
        id: 'd-1',
        deal_custom_fields: [
          {
            custom_field: { label: 'Investimento disponível para franquia - 75 a 150 mil' },
            value: 'Sim',
          },
          { custom_field: { label: 'Observações' }, value: 'Ligar à tarde' },
          { custom_field: { label: 'Nome da Marca' }, value: 'Marca Exemplo' },
          { custom_field: { label: 'OBS' }, value: ['a', 'b'] },
          { custom_field: { label: 'Outro campo' }, value: 'fica fora' },
        ],
      } as Parameters<typeof answersOfDeal>[0]),
    ).toEqual({
      'Investimento disponível': 'Sim',
      Observações: 'Ligar à tarde',
      'Nome da marca': 'Marca Exemplo',
      OBS: 'a, b',
    });
    expect(answersOfDeal({ id: 'd-2' } as Parameters<typeof answersOfDeal>[0])).toBeNull();
  });
});

describe('the lead page', () => {
  it('names the ad, its set and its campaign from the ad tables, and keeps the UTMs', async () => {
    const [account] = await db
      .insert(adAccounts)
      .values({ platform: 'meta', externalId: 'act_9', name: 'Conta' })
      .returning({ id: adAccounts.id });
    const [campaign] = await db
      .insert(adCampaigns)
      .values({ adAccountId: account!.id, externalId: '700', name: 'Campanha Exemplo' })
      .returning({ id: adCampaigns.id });
    const [set] = await db
      .insert(adSets)
      .values({
        campaignId: campaign!.id,
        externalId: '701',
        name: 'Conjunto Exemplo',
      })
      .returning({ id: adSets.id });
    await db.insert(adAds).values({
      adAccountId: account!.id,
      campaignId: campaign!.id,
      adSetId: set!.id,
      externalId: '702',
      name: 'Anúncio Exemplo',
    });
    const meta = await upsertLead(db, {
      source: 'meta_lead_ads',
      phone: '21987650001',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      skipResearch: true,
      distribute: false,
      attribution: {
        adPlatform: 'meta',
        adCampaignExternalId: '700',
        adSetExternalId: '701',
        adExternalId: '702',
        utmSource: 'meta:instagram',
      },
      event: { kind: 'lead.received.meta_lead_ads' },
    });
    const loaded = await loadLead(db, meta.lead.id);
    expect(loaded?.lead.origin.ad).toEqual({
      platform: 'meta',
      campaign: { externalId: '700', name: 'Campanha Exemplo' },
      adSet: { externalId: '701', name: 'Conjunto Exemplo' },
      ad: { externalId: '702', name: 'Anúncio Exemplo' },
    });
    expect(loaded?.lead.origin.utm).toMatchObject({ source: 'meta:instagram' });

    const site = await upsertLead(db, {
      source: 'rd_station',
      phone: '21987650002',
      clientId: WINGS_CLIENT_ID,
      clientMapped: false,
      skipResearch: true,
      distribute: false,
      trafficSource: 'Busca Paga | Google',
      conversionIdentifier: 'formatar-franquia',
      formAnswers: { 'Investimento disponível': 'Sim' },
      event: { kind: 'lead.received.rd_station' },
    });
    const page = (await loadLead(db, site.lead.id))!.lead;
    expect(page.origin).toMatchObject({
      ad: null,
      utm: null,
      trafficSource: 'Busca Paga | Google',
      conversionIdentifier: 'formatar-franquia',
    });
    expect(page.formAnswers).toEqual({ 'Investimento disponível': 'Sim' });
  });
});
