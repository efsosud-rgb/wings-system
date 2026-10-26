# Câmeras

Análise de câmeras para as lojas dos clientes, com piloto no escritório da Wings. Base do módulo (26/10/2026, ordem
do Eric de 24/10): o cadastro dos dispositivos, a porta de entrada dos lotes, o modelo de dados e o painel. Esta etapa não
depende da marca das câmeras.

## Privacidade (decisão do Eric, 24/10/2026)

- **O vídeo nunca sai do local.** O Wings recebe só números agregados: contagens, ocupação e alertas.
- Nenhuma imagem, rosto ou identificação de pessoa no servidor ou no banco. A API de entrada só aceita os campos do
  contrato (`cameraBatchSchema`, estrito): qualquer outro campo, imagem incluída, recusa o lote inteiro com 400.
- **Sem reconhecimento facial** (dado biométrico sensível, LGPD art. 11).
- **Sem área por mesa de trabalho**: mesa equivale a uma pessoa, e a equipe da Wings é PJ. No escritório, só porta,
  recepção e salas de reunião. Os tipos de área possíveis são porta, recepção, sala de reunião, salão, caixa e "outra".
- Nomes no sistema são de lugares e equipamentos (unidade, área, dispositivo), nunca de pessoas.

## Onde e quem

- **Gestão → Câmeras** (`/gestao/cameras`), no padrão do sistema. Permissões `cameras.read` (Diretoria e Admin Master
  veem o painel e a lista de dispositivos) e `cameras.manage` (só o Admin Master cadastra e revoga dispositivos). No
  piloto, mais ninguém. Depois: perfis do cliente, com a franqueadora vendo a rede (`dim_unidade.marca_sk`) e o
  franqueado a própria unidade, pelo `tenant_sk` e pela RLS que já existem no modelo.

## Dados (`docs/bi/README.md`, migração 0098)

Dimensões novas: `dim_unidade` (loja ou escritório), `dim_area` (porta, recepção, sala 1…), `dim_dispositivo` (câmera
ou caixa de análise) e `dim_faixa_horaria` (as 96 faixas de 15 minutos); `dim_data` e `dim_tenant` são reusadas.
Fatos: `fato_fluxo_area` (snapshot periódico: uma linha por área e dispositivo a cada 15 minutos, com entradas e saídas
aditivas, ocupação máxima, soma e número de permanências; a média sai na consulta) e `fato_alerta` (transação: uma linha
por alerta). `fonte` e `carregado_em` em todo fato; `tenant_sk` com RLS. O token de cada dispositivo fica em
`camera_devices` (`public`), só como SHA-256.

## API de entrada

`POST /public/cameras/batches`, com `Authorization: Bearer <token do dispositivo>`. O token é gerado no cadastro e
mostrado uma vez; revogado, responde 410. Um lote tem até 200 intervalos de 15 minutos:

```json
{
  "intervals": [
    {
      "startsAt": "2026-10-20T09:00:00-03:00",
      "entries": 9,
      "exits": 8,
      "maxOccupancy": null,
      "dwellSeconds": null,
      "dwellCount": null,
      "alerts": [
        {
          "kind": "sala_ocupada_sem_reserva",
          "startedAt": "2026-10-20T09:00:00-03:00",
          "endedAt": null,
          "people": 4
        }
      ]
    }
  ]
}
```

- `startsAt` cai num quarto de hora (:00, :15, :30, :45) e dentro do calendário do modelo (2024 a 2030).
- Uma contagem que o dispositivo não faz vai como `null` (a porta não mede ocupação; a sala não conta entradas). Nunca
  zero no lugar de "não contei".
- **Idempotente pela chave dispositivo + intervalo**: o mesmo lote mandado duas vezes não duplica nada; um lote corrigido
  substitui os números daquele intervalo. Alertas são únicos por dispositivo, início e tipo.
- Tipos de alerta: `sala_ocupada_sem_reserva`, `sala_reservada_vazia`, `lotacao`, `permanencia_longa`,
  `dispositivo_offline`.
- **Dispositivo de teste** (`test: true` no cadastro): os lotes dele entram com `fonte = teste` e **nunca aparecem no
  painel**. É assim que os testes rodam lotes gravados (`apps/api/src/modules/cameras/fixtures/`, um dia inventado do
  escritório) sem sujar os números de produção.
- Limite: 120 lotes por minuto por origem.

## O que cada número do painel responde

Tudo no período escolhido (os mesmos períodos do Painel de Vendas; 30 dias por padrão) e na unidade escolhida (ou em
todas).

| Número                        | Responde                                                                                                                   | De onde vem                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Entradas por hora             | A que horas do dia mais gente entra? Soma das entradas pela porta, hora a hora.                                            | `fato_fluxo_area.entradas` das áreas do tipo porta, por `dim_faixa_horaria.hora`.                 |
| Por dia da semana             | Em que dia da semana entra mais gente?                                                                                     | O mesmo, por `dim_data.dia_semana`.                                                               |
| Horários de pico              | As três horas com mais entradas no período.                                                                                | As três maiores de "Entradas por hora".                                                           |
| Salas de reunião: ocupação    | De todas as faixas de 15 minutos que o dispositivo observou, em quantas havia alguém na sala (e a porcentagem)?            | `ocupacao_maxima > 0` sobre as faixas da área do tipo sala de reunião.                            |
| Salas de reunião: máximo      | O maior número de pessoas ao mesmo tempo na sala.                                                                          | `max(ocupacao_maxima)`.                                                                           |
| Salas de reunião: permanência | Quanto tempo, em média, uma reunião durou (permanências encerradas).                                                       | `sum(permanencia_segundos) / sum(permanencias)`, calculado na consulta.                           |
| Reservas que ficaram vazias   | Quantas reservas de sala não tiveram ninguém na sala. **"—" até a Agenda cadastrar as salas de reunião.**                  | Virá de `fato_alerta` (`sala_reservada_vazia`) cruzado com a Agenda; hoje a Agenda não tem salas. |
| Alertas                       | Quantos alertas de cada tipo o dispositivo emitiu.                                                                         | `fato_alerta` por tipo.                                                                           |
| Dispositivos                  | Cada dispositivo, a área, o tipo e quando mandou o último lote. "—" com "dispositivo ainda não instalado" sem nenhum lote. | `camera_devices.last_batch_at` e `dim_dispositivo`.                                               |

Sem dado, "—" e o motivo: nenhum dispositivo cadastrado; dispositivo ainda não instalado (nenhum lote recebido); nenhum
lote no período; nenhum dispositivo na porta (as entradas não são contadas). Nunca um zero no lugar.

## Fica para depois (depende das câmeras do escritório)

O programa da caixa de análise, que ou lê a contagem e o mapa de calor que a própria câmera já faz (pela API do
fabricante) ou roda o **RF-DETR (Apache 2.0)** com rastreamento num computador pequeno no local, e manda os lotes para a
API acima. **Nada de YOLO da Ultralytics (AGPL).** Também ficam para depois: os perfis do cliente (franqueadora e
franqueado), o cruzamento com as reservas da Agenda e a `fato_alerta` vinda da própria caixa.

## Testes

- `apps/api/src/db/bi-dw.test.ts`: DDL num Postgres real (23 tabelas), RLS por papel comum nas dimensões e fatos novos,
  as 96 faixas e `dw.faixa_sk`, nenhuma coluna de imagem, rosto ou pessoa.
- `apps/api/src/modules/cameras/cameras.test.ts`: cadastro só pelo Admin Master com o token uma vez, lotes gravados
  entregues com o token (idempotência, correção, token errado 401, revogado 410, campo de imagem 400, intervalo fora do
  quarto de hora 400), painel com os números do lote gravado, dispositivo de teste fora do painel, visão por papel.
- `apps/web/src/pages/CamerasPage.test.tsx`: a tela com os números, os "—" com motivo e o cadastro do Admin.
