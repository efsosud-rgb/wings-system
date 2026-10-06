// Lê no RD CRM, só leitura, os negócios de teste: nome ou motivo de perda com "teste"
// (isTestDeal, a mesma regra do painel e da importação, que contou 60 no lote
// rd-crm-20261006T1840Z sem marcá-los no banco). Imprime só os ids ("rd <id>") e, no fim,
// "total <n> de <lidos>"; nunca nome, e-mail ou telefone.
//
// Roda dentro do contêiner da API, que tem o token (ele não sai de lá):
//   docker exec -i <api> node --input-type=module < rd-testes.mjs
import { isTestDeal } from '@wings/shared';
import { rdCrmReader } from '/app/apps/api/dist/modules/leads/rd-import.js';

const token = process.env.RD_CRM_API_TOKEN;
if (!token) {
  console.error('RD_CRM_API_TOKEN não está definido neste contêiner');
  process.exit(3);
}

try {
  const deals = await rdCrmReader(token).deals();
  let tests = 0;
  for (const deal of deals) {
    const id = deal.id ?? deal._id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id)) continue;
    if (isTestDeal(deal.name ?? null, deal.deal_lost_reason?.name ?? null)) {
      console.log(`rd ${id}`);
      tests += 1;
    }
  }
  console.log(`total ${tests} de ${deals.length}`);
} catch (error) {
  // Só a classe: a mensagem do fetch pode trazer o endereço, e o token do RD vai nele.
  console.error(`leitura do RD falhou (${error instanceof Error ? error.name : 'erro'})`);
  process.exit(1);
}
