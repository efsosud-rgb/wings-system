import { WINGS_CLIENT_ID } from '@wings/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../db/client.js';
import {
  adAccounts,
  adAds,
  adCampaigns,
  crmStages,
  leadStageHistory,
  leads,
} from '../../../db/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../../../test/db.js';
import { crmFunnel } from './funnel-crm.js';

/**
 * The funnel's CRM side by campaign and ad, from the Wings System's own leads
 * (orchestrator, 13/10): by the ad ids the lead keeps, else its UTMs; meetings
 * and proposals by the furthest stage reached; robots out. Made-up data.
 */

let harness: TestDatabase;
let db: Database;
const stageId = new Map<string, string>();
let campaignId = '';
let adId = '';

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  const names = [
    'Sem contato',
    'Tentando contato',
    'Reunião agendada',
    'Reunião realizada',
    'Proposta enviada',
  ];
  const stages = await db
    .insert(crmStages)
    .values(names.map((name, index) => ({ pipeline: 'formatacao', name, position: index + 1 })))
    .returning({ id: crmStages.id, name: crmStages.name });
  for (const stage of stages) stageId.set(stage.name, stage.id);
  const [account] = await db
    .insert(adAccounts)
    .values({ platform: 'meta', externalId: 'act_1', name: 'Conta de teste' })
    .returning({ id: adAccounts.id });
  const [campaign] = await db
    .insert(adCampaigns)
    .values({ adAccountId: account!.id, externalId: '900', name: 'META | IG | Formatação | Teste' })
    .returning({ id: adCampaigns.id });
  campaignId = campaign!.id;
  const [ad] = await db
    .insert(adAds)
    .values({
      adAccountId: account!.id,
      campaignId,
      externalId: '901',
      name: 'Vídeo 1',
      utmContent: 'video-1',
    })
    .returning({ id: adAds.id });
  adId = ad!.id;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

const DAY = new Date('2026-10-05T15:00:00Z');
const lead = async (extra: Partial<typeof leads.$inferInsert>) => {
  const [row] = await db
    .insert(leads)
    .values({
      source: 'rd_station',
      pipeline: 'formatacao',
      clientId: WINGS_CLIENT_ID,
      enteredAt: DAY,
      ...extra,
    })
    .returning({ id: leads.id });
  return row!.id;
};

describe('crmFunnel', () => {
  it('counts leads, meetings and proposals per campaign and per ad', async () => {
    // By the ad id: reached the proposal.
    await lead({ adExternalId: '901', stageId: stageId.get('Proposta enviada') });
    // By the UTMs (draft utm, accents and case aside): back in "Sem contato" after a meeting.
    const back = await lead({
      utmCampaign: 'Formatacao_Teste_Out26',
      utmContent: 'VIDEO-1',
      stageId: stageId.get('Sem contato'),
    });
    await db.insert(leadStageHistory).values({
      leadId: back,
      toStageId: stageId.get('Reunião agendada'),
      fromStageId: stageId.get('Sem contato'),
      source: 'wings',
    });
    // By the campaign id only, won: every stage.
    await lead({ adCampaignExternalId: '900', won: true });
    // A robot, out; a lead of an unknown campaign, out of the campaigns; one outside the window.
    await lead({
      adCampaignExternalId: '900',
      suspectAt: DAY,
      suspectReasons: ['robot_email', 'capital_ddd', 'direct_traffic'],
    });
    await lead({ utmCampaign: 'campanha_que_nao_existe' });
    await lead({ adCampaignExternalId: '900', enteredAt: new Date('2026-08-01T12:00:00Z') });

    const result = await crmFunnel(db, {
      campaigns: [
        {
          id: campaignId,
          externalId: '900',
          name: 'META | IG | Formatação | Teste',
          draftUtm: 'formatacao_teste_out26',
        },
      ],
      start: new Date('2026-10-01T03:00:00Z'),
      end: new Date('2026-10-13T02:59:59Z'),
    });
    expect(result.byCampaign.get(campaignId)).toEqual({ leads: 3, meetings: 3, proposals: 2 });
    expect(result.byAd.get(adId)).toEqual({ leads: 2, meetings: 2, proposals: 1 });
    expect(result.leadsWithoutCampaign).toBe(1);
  });
});
