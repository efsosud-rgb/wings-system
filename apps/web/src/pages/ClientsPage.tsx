import {
  CLIENT_NAME_MAX,
  CLIENT_NUMBER_MAX,
  LEAD_LINK_CHANNELS,
  LEAD_CHANNEL_LABELS,
  LEAD_SOURCE_RULE_KINDS,
  LEAD_SOURCE_RULE_KIND_LABELS,
  WINGS_CLIENT_ID,
  formatExpansionEntry,
  type Client,
  type LeadLinkChannel,
  type LeadSourceRuleKind,
} from '@wings/shared';
import { useState } from 'react';
import { ApiError } from '../api/client.js';
import { useClients, useCreateClient, useUpdateClient } from '../api/clients.js';
import {
  useCreateSourceRule,
  useCreateTrackingLink,
  useDeleteSourceRule,
  useSourceRules,
  useTrackingLinks,
  useUpdateExpansionArea,
} from '../api/leads.js';
import { Alert, Button, Field, Input, Select } from '../components/ui.js';

/**
 * Administração → Clientes. The smallest register that lets work be filed
 * under who it is for: a name, and whether the client is still active. Wings
 * Company is the fixed first row. Since the Funil (part 1), a client also
 * carries its expansion area and its tracked WhatsApp links, and the page
 * keeps the rules that map a landing page or a Meta form to a client.
 */

function ExpansionArea({ client }: { client: Client }) {
  const update = useUpdateExpansionArea();
  const [text, setText] = useState(client.expansionArea.map(formatExpansionEntry).join(', '));
  return (
    <form
      className="lead-area"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate({
          clientId: client.id,
          expansionArea: text
            .split(/[,;\n]/)
            .map((entry) => entry.trim())
            .filter(Boolean),
        });
      }}
    >
      <Field
        label="Área de expansão"
        hint="Estados ou cidades, separados por vírgula: SP, Campinas/SP, Belém/PA. A pesquisa do lead compara a região do DDD com esta lista."
      >
        <Input
          aria-label={`Área de expansão de ${client.name}`}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            update.reset();
          }}
        />
      </Field>
      {update.error && (
        <div className="field-error" role="alert">
          {update.error instanceof ApiError ? update.error.message : 'Não foi possível salvar a área.'}
        </div>
      )}
      {update.isSuccess && <div className="field-hint">Área salva.</div>}
      <Button type="submit" variant="ghost" disabled={update.isPending}>
        Salvar área
      </Button>
    </form>
  );
}

function TrackingLinks({ client }: { client: Client }) {
  const links = useTrackingLinks(client.id);
  const create = useCreateTrackingLink();
  const [channel, setChannel] = useState<LeadLinkChannel>('instagram');
  const [copied, setCopied] = useState<string | null>(null);
  const list = links.data?.links ?? [];

  return (
    <div className="lead-links-admin">
      <h3 className="lead-subhead">Links rastreáveis do WhatsApp</h3>
      <p className="muted">
        Cada link abre o WhatsApp da Wings com um código já escrito. Quem manda a mensagem é etiquetado com este
        cliente e o canal do link.
      </p>
      {links.data && !links.data.phoneConfigured && (
        <Alert kind="warning">O número de WhatsApp da Wings (WINGS_WHATSAPP_NUMBER) não está configurado neste ambiente.</Alert>
      )}
      <form
        className="clients-rename"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({ clientId: client.id, channel });
        }}
      >
        <Select aria-label={`Canal do novo link de ${client.name}`} value={channel} onChange={(event) => setChannel(event.target.value as LeadLinkChannel)}>
          {LEAD_LINK_CHANNELS.map((item) => (
            <option key={item} value={item}>
              {LEAD_CHANNEL_LABELS[item]}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="ghost" disabled={create.isPending || links.data?.phoneConfigured === false}>
          Gerar link
        </Button>
      </form>
      {create.error && (
        <div className="field-error" role="alert">
          {create.error instanceof ApiError ? create.error.message : 'Não foi possível gerar o link.'}
        </div>
      )}
      {list.length > 0 && (
        <table className="table lead-links-table">
          <thead>
            <tr>
              <th>Canal</th>
              <th>Link</th>
              <th>Mensagens</th>
              <th>
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((link) => (
              <tr key={link.id}>
                <td>{LEAD_CHANNEL_LABELS[link.channel]}</td>
                <td className="mono lead-wrap">{link.url}</td>
                <td>{link.hits}</td>
                <td>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard?.writeText(link.url).then(() => setCopied(link.id));
                    }}
                  >
                    {copied === link.id ? 'Copiado' : 'Copiar'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** `NN` as the Drive shows it: `Clientes/07. Nome`. */
const numberLabel = (number: number | null) =>
  number === null ? '—' : String(number).padStart(2, '0');

function ClientRow({ client, open, onToggle }: { client: Client; open: boolean; onToggle: () => void }) {
  const update = useUpdateClient();
  const [name, setName] = useState(client.name);
  const [number, setNumber] = useState(client.number === null ? '' : String(client.number));
  const [editing, setEditing] = useState(false);
  const fixed = client.id === WINGS_CLIENT_ID;

  return (
    <>
      <tr>
        <td className="mono">{editing ? null : numberLabel(client.number)}</td>
        <td>
          {editing ? (
            <form
              className="clients-rename"
              onSubmit={(event) => {
                event.preventDefault();
                const next = Number(number);
                update.mutate(
                  {
                    id: client.id,
                    ...(name !== client.name ? { name } : {}),
                    ...(Number.isInteger(next) && next !== client.number ? { number: next } : {}),
                  },
                  { onSuccess: () => setEditing(false) },
                );
              }}
            >
              <input
                className="control clients-number"
                aria-label={`Número de ${client.name}`}
                type="number"
                min={1}
                max={CLIENT_NUMBER_MAX}
                value={number}
                onChange={(event) => setNumber(event.target.value)}
              />
              <input
                className="control"
                aria-label={`Novo nome de ${client.name}`}
                value={name}
                maxLength={CLIENT_NAME_MAX}
                onChange={(event) => setName(event.target.value)}
              />
              <Button type="submit" variant="ghost" disabled={update.isPending}>
                Salvar
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setName(client.name);
                  setNumber(client.number === null ? '' : String(client.number));
                  setEditing(false);
                  update.reset();
                }}
              >
                Cancelar
              </Button>
            </form>
          ) : (
            <>
              {client.name}
              {fixed && <span className="tag">padrão</span>}
              {client.expansionArea.length > 0 && (
                <div className="cell-sub">Expansão: {client.expansionArea.map(formatExpansionEntry).join(', ')}</div>
              )}
            </>
          )}
          {update.error && (
            <div className="field-error" role="alert">
              {update.error instanceof ApiError ? update.error.message : 'Não foi possível salvar.'}
            </div>
          )}
        </td>
        <td>
          <span className={`status status-${client.active ? 'active' : 'inactive'}`}>
            {client.active ? 'Ativo' : 'Inativo'}
          </span>
        </td>
        <td>
          <div className="clients-actions">
            {!fixed && !editing && (
              <>
                <Button type="button" variant="ghost" onClick={() => setEditing(true)}>
                  Editar
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: client.id, active: !client.active })}
                >
                  {client.active ? 'Desativar' : 'Reativar'}
                </Button>
              </>
            )}
            {!fixed && client.active && (
              <Button type="button" variant="ghost" aria-expanded={open} onClick={onToggle}>
                {open ? 'Fechar' : 'Links e expansão'}
              </Button>
            )}
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} className="lead-client-details">
            <ExpansionArea client={client} />
            <TrackingLinks client={client} />
          </td>
        </tr>
      )}
    </>
  );
}

function SourceRules({ clients }: { clients: Client[] }) {
  const rules = useSourceRules();
  const create = useCreateSourceRule();
  const remove = useDeleteSourceRule();
  const [kind, setKind] = useState<LeadSourceRuleKind>('landing_page');
  const [pattern, setPattern] = useState('');
  const [clientId, setClientId] = useState('');
  const list = rules.data?.rules ?? [];

  return (
    <section className="block">
      <h2>Origens de leads</h2>
      <p className="muted">
        De qual cliente é cada landing page ou formulário. Uma conversão sem regra vira lead mesmo assim, marcado
        "sem regra" e arquivado na Wings Company até alguém cadastrar a regra aqui.
      </p>
      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({ kind, pattern, clientId }, { onSuccess: () => setPattern('') });
        }}
      >
        <label className="field">
          <span className="field-label">Tipo</span>
          <select className="control" value={kind} onChange={(event) => setKind(event.target.value as LeadSourceRuleKind)}>
            {LEAD_SOURCE_RULE_KINDS.map((item) => (
              <option key={item} value={item}>
                {LEAD_SOURCE_RULE_KIND_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Padrão</span>
          <input
            className="control"
            value={pattern}
            placeholder={kind === 'landing_page' ? 'sushi-do-bairro ou lp.cliente.com.br' : 'id numérico'}
            onChange={(event) => {
              setPattern(event.target.value);
              create.reset();
            }}
          />
        </label>
        <label className="field">
          <span className="field-label">Cliente</span>
          <select className="control" value={clientId} onChange={(event) => setClientId(event.target.value)}>
            <option value="">Escolha</option>
            {clients
              .filter((client) => client.active)
              .map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
          </select>
        </label>
        <Button type="submit" disabled={create.isPending || pattern.trim().length < 2 || !clientId}>
          Adicionar regra
        </Button>
      </form>
      {create.error && (
        <Alert kind="error">{create.error instanceof ApiError ? create.error.message : 'Não foi possível salvar a regra.'}</Alert>
      )}
      {rules.isError && <Alert kind="error">Não foi possível carregar as regras.</Alert>}
      <table className="table">
        <thead>
          <tr>
            <th>Tipo</th>
            <th>Padrão</th>
            <th>Cliente</th>
            <th>
              <span className="sr-only">Ações</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                Nenhuma regra ainda.
              </td>
            </tr>
          )}
          {list.map((rule) => (
            <tr key={rule.id}>
              <td>{LEAD_SOURCE_RULE_KIND_LABELS[rule.kind].split(' (')[0]}</td>
              <td className="mono">{rule.pattern}</td>
              <td>{rule.clientName}</td>
              <td>
                <Button type="button" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(rule.id)}>
                  Remover
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function ClientsPage() {
  const clients = useClients();
  const create = useCreateClient();
  const [name, setName] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const list = clients.data?.clients ?? [];

  return (
    <>
      <header className="page-header">
        <h1>Clientes</h1>
        <p>
          Para quem o trabalho é feito. Cada cliente tem um número e uma pasta no Drive,
          Clientes/NN. Nome, criada no cadastro. A mídia gerada é arquivada pelo cliente escolhido; o
          nome do cliente não é enviado a fornecedores.
        </p>
      </header>

      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(name, { onSuccess: () => setName('') });
        }}
      >
        <label className="field">
          <span className="field-label">Novo cliente</span>
          <input
            className="control"
            value={name}
            maxLength={CLIENT_NAME_MAX}
            placeholder="Nome do cliente"
            onChange={(event) => {
              setName(event.target.value);
              create.reset();
            }}
          />
        </label>
        <Button type="submit" disabled={create.isPending || name.trim().length < 2}>
          Cadastrar cliente
        </Button>
      </form>
      {create.error && (
        <Alert kind="error">
          {create.error instanceof ApiError
            ? create.error.message
            : 'Não foi possível cadastrar o cliente.'}
        </Alert>
      )}
      {clients.isError && <Alert kind="error">Não foi possível carregar os clientes.</Alert>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th title="O número da pasta do cliente no Drive: Clientes/NN. Nome">Nº</th>
              <th>Nome</th>
              <th>Situação</th>
              <th>
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {clients.isLoading && (
              <tr>
                <td colSpan={4} className="muted">
                  Carregando…
                </td>
              </tr>
            )}
            {list.map((client) => (
              <ClientRow
                key={client.id}
                client={client}
                open={openId === client.id}
                onToggle={() => setOpenId((current) => (current === client.id ? null : client.id))}
              />
            ))}
          </tbody>
        </table>
      </div>

      <SourceRules clients={list} />
    </>
  );
}
