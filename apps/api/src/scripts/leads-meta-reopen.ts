import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createDb } from '../db/client.js';
import { loadDotEnv } from '../db/load-env.js';
import { loadEnv } from '../env.js';
import {
  reprocessMetaLeadgenEvent,
  type MetaReprocessReport,
} from '../modules/leads/meta-intake.js';

/**
 * Runs one Meta Lead Ads event again under today's rule (a form lead whose
 * phone landed on a closed or unworked lead opens a deal of its own, by the
 * funnel's rotation, with the first-contact task and the RD copy). For the
 * events the old rule only attached (docs/leads/meta-lead-ads.md).
 *
 *   node dist/scripts/leads-meta-reopen.js estado  --leadgen=<id>   # reads the queue and the lead
 *   node dist/scripts/leads-meta-reopen.js simular --leadgen=<id>   # + Graph API, rotation and RD, writes nothing
 *   node dist/scripts/leads-meta-reopen.js aplicar --leadgen=<id>   # writes; asks for a typed PRODUCAO
 *
 * Runs inside the API container (it needs the API's own environment). The
 * output is ids, statuses and sellers' first names — never the person.
 */
function format(r: MetaReprocessReport): string {
  const lines = [
    `modo: ${r.mode}`,
    `evento ${r.event.leadgenId} (${r.event.id}): ${r.event.status}, lead criado ${r.event.leadCreated ? 'sim' : 'não'}, RD ${r.event.rdOutcome ?? '-'}${r.event.rdDealId ? ` (${r.event.rdDealId})` : ''}, criado na Meta ${r.event.createdTime ?? '-'}`,
    r.attachedTo
      ? `ligado ao lead ${r.attachedTo.id}: origem ${r.attachedTo.source}, funil ${r.attachedTo.pipeline ?? '-'}, etapa ${r.attachedTo.stage ?? '-'}, dono ${r.attachedTo.owner ?? '-'}, ${r.attachedTo.closed ? 'fechado' : 'aberto'}, ${r.attachedTo.workable ? 'trabalhável' : 'ninguém trabalha'}, RD ${r.attachedTo.rdDealId ?? '-'}`
      : 'ligado a lead nenhum',
  ];
  if (r.refusal) lines.push(`nada a fazer: ${r.refusal}`);
  if (r.plan)
    lines.push(
      `${r.mode === 'aplicar' ? 'plano' : 'faria'}: negociação nova no funil ${r.plan.pipeline ?? '-'}, etapa ${r.plan.entryStage ?? '-'}, próximo do rodízio ${r.plan.nextInRotation ?? '(rodízio vazio)'}, RD ${
        {
          would_create: 'criaria negócio novo',
          would_link_open_deal: `ligaria ao negócio aberto ${r.plan.openRdDealId}`,
          disabled: 'cópia desligada',
          no_pipeline: 'sem funil',
          unknown: 'não respondeu',
        }[r.plan.rd]
      }`,
    );
  if (r.result)
    lines.push(
      r.result.newLeadId
        ? `APLICADO: lead novo ${r.result.newLeadId}, dono ${r.result.owner ?? '(sem dono)'}, etapa ${r.result.stage ?? '-'}, tarefa ${r.result.task ? 'criada' : 'não'}, RD ${r.result.rdOutcome ?? '-'}${r.result.rdDealId ? ` (${r.result.rdDealId})` : ''}`
        : `APLICADO sem lead novo (RD ${r.result.rdOutcome ?? '-'}): veja o evento`,
    );
  return lines.join('\n');
}

async function main() {
  loadDotEnv();
  const env = loadEnv(process.env);
  const mode = process.argv[2];
  const leadgenId = process.argv.find((arg) => arg.startsWith('--leadgen='))?.slice(10);
  if ((mode !== 'estado' && mode !== 'simular' && mode !== 'aplicar') || !leadgenId) {
    console.error('uso: leads-meta-reopen estado|simular|aplicar --leadgen=<leadgen id>');
    process.exit(2);
  }
  if (mode === 'aplicar') {
    if (!stdin.isTTY) {
      console.error('aplicar precisa de um terminal: digite PRODUCAO para gravar');
      process.exit(2);
    }
    const rl = createInterface({ input: stdin, output: stdout });
    const typed = await rl.question(`Gravar a negociação nova do evento ${leadgenId}? Digite PRODUCAO: `);
    rl.close();
    if (typed.trim() !== 'PRODUCAO') {
      console.error('cancelado: nada gravado');
      process.exit(1);
    }
  }
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const report = await reprocessMetaLeadgenEvent(
      {
        db,
        accessToken: env.META_LEADS_ACCESS_TOKEN ?? null,
        rdCrmToken: env.RD_CRM_API_TOKEN ?? null,
        expansionOwnerId: env.EXPANSION_OWNER_RD_USER_ID ?? null,
        rdCopyEnabled: env.META_LEADS_RD_COPY_ENABLED !== 'false',
        log: (facts) => console.warn(JSON.stringify(facts)),
      },
      leadgenId,
      mode,
    );
    console.warn(format(report));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // The message is a code or a status, never the person or a token.
  console.error(error instanceof Error ? error.message : 'error');
  process.exit(1);
});
