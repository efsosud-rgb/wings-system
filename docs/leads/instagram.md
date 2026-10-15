# Conferência do Instagram do lead do site

Desde 15/10/2026 (ordem do Eric). Todo lead que chega pelo formulário do site com Instagram é conferido em segundo plano, e o botão **Conferir de novo** da ficha usa a mesma função. O lead nasce antes e nunca espera a conferência. O resultado é só da equipe: **nunca** aparece para quem preencheu o formulário.

## Os passos (para no primeiro que decide)

1. **Formato** (`normalizeInstagram`): 1 a 30 letras, números, ponto ou sublinhado. Fora disso: `nao_encontrado`, suspeito.
2. **API oficial da Meta** (Business Discovery, pela conta comercial da Wings): nome, bio, site, seguidores e posts. Só vê conta comercial ou de criador; **conta pessoal não aparece, e isso não prova que o perfil é falso**. Sem as variáveis, o passo é pulado.
3. **Busca na web** (Brave): `instagram.com/<usuário>`; uma página pública do perfil conta como encontrado pela busca (posts e reels de outro endereço não contam).
4. **IA** (OpenRouter, o modelo de `LEAD_RESEARCH_MODEL`): compara nome, bio e site do perfil com o nome da empresa e o site do formulário e diz `bate`, `nao_bate` ou `sem_dados`. Só a empresa e o perfil vão no pedido, nunca o nome da pessoa, o telefone ou o e-mail; o texto do perfil é tratado como dado, não como instrução.

Nada raspa o site do Instagram (termos da Meta e regra da casa): só API oficial, busca e IA.

## O resultado

- **Status**: `confere`, `nao_encontrado`, `nao_bate`, `pendente` (esperando o worker) e `erro` (nenhuma fonte decidiu: sem provedor, teto do dia, falha).
- **Fonte**: `meta`, `busca` ou `nenhuma`; mais quando foi conferido e, vindo da Meta, seguidores e posts.
- **Suspeito e falso** (regras do Eric de 15/10): `nao_encontrado` é **suspeito**; só vira **falso** quando o perfil não apareceu nem na Meta nem na busca, as duas tendo olhado. Um passo pulado, recusado pelo teto ou que falhou não olhou: fica suspeito. `nao_bate` e `erro` não entram na conta. Um formato inválido é suspeito (nenhuma busca rodou).
- A **correção do vendedor** (Marcar como confere / Marcar como falso / Desfazer) vale mais que a máquina, fica na linha do tempo (`instagram.corrected`, com quem fez) e o resultado automático continua guardado. Os filtros e as estatísticas leem o veredito efetivo (`leads.instagram_verdict_effective`).

## Onde aparece

- Ficha, "Dados do formulário": status, fonte, hora, seguidores/posts e o link do perfil.
- Negociações: filtro **Instagram** (suspeito, falso, suspeito ou falso).
- Painel de Vendas, "Por origem e campanha": colunas **Suspeitos** e **Falsos** por campanha e a tabela **Instagram por página** (slug). Linha sem nenhum lead conferido mostra "—", nunca zero.
- Para conferir sem dado pessoal: `lead_origin_analysis` tem `instagram_check_status`, `instagram_check_source`, `instagram_checked_at`, `instagram_verdict`, `instagram_manual` e `instagram_verdict_effective`, por `landing_page` e `utm_campaign`.

## Dinheiro e variáveis (só nomes)

O teto do dia é próprio (US$ 0,50), no mesmo `lead_enrichment_ledger` do `LEAD_RESEARCH_DAILY_USD` (passos `ig_meta`, `ig_search`, `ig_ai`; dia de São Paulo; reserva antes de cada chamada paga, sem nova tentativa; a IA acerta a reserva ao custo real).

| Variável                                                                                           | Onde                    | Para quê                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `INSTAGRAM_CHECK_ENABLED`                                                                          | API e worker            | só `true` liga. Na API enfileira o trabalho; no worker é a chave de quem gasta. Desligado, vale a conferência antiga. |
| `INSTAGRAM_DISCOVERY_ACCOUNT_ID`, `INSTAGRAM_DISCOVERY_TOKEN`                                      | worker (a API já os lê) | conta comercial do Instagram da Wings e o token do Business Discovery.                                                |
| `INSTAGRAM_CHECK_DAILY_USD`                                                                        | worker                  | teto do dia (padrão 0,5).                                                                                             |
| `INSTAGRAM_CHECK_AI_USD_PER_CALL`                                                                  | worker                  | reserva por comparação (padrão 0,004).                                                                                |
| `BRAVE_SEARCH_API_KEY`, `OPENROUTER_API_KEY`, `LEAD_RESEARCH_MODEL`, `ENRICH_SEARCH_USD_PER_QUERY` | worker                  | os mesmos da pesquisa do lead.                                                                                        |
| `WORKER_JOB_TYPES`                                                                                 | worker                  | se estiver definida, precisa incluir `check_instagram`.                                                               |

## Não verificado ao vivo

Os códigos de erro do Business Discovery para um usuário que não é conta comercial (110, 24 e subcódigo 2207013), o formato das respostas da Brave para páginas do Instagram e `usage.cost` do OpenRouter seguem as referências; o log de formato (só nomes de chaves e números) mostra o que vier na primeira conferência real.

## Ficha, ref e Sofia

Ver "Do formulário ao WhatsApp" em `docs/leads/formularios.md`.
