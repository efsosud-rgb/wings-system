import {
  CLIENT_NAME_MAX,
  CLIENT_NUMBER_MAX,
  LEAD_LINK_CHANNELS,
  LEAD_CHANNEL_LABELS,
  PROJECT_STATUS_LABELS,
  WINGS_CLIENT_ID,
  formatCnpj,
  formatExpansionEntry,
  isValidCnpj,
  type Client,
  type LeadLinkChannel,
} from '@wings/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { useClients, useCnpjLookup, useCreateClient, useUpdateClient } from '../api/clients.js';
import { useProjects } from '../api/projects.js';
import { useCreateTrackingLink, useTrackingLinks, useUpdateExpansionArea } from '../api/leads.js';
import { ProjectStatusTag, StatusDialog, stageLabel } from '../components/projects/ProjectParts.js';
import { Alert, Button, Field, Input, Select } from '../components/ui.js';
import type { ClientProject } from '@wings/shared';

/**
 * Formatação → Clientes. The register of who work is for: a quick
 * registration (name, and the CNPJ and main contact when known) and, per
 * client, the full record ("ficha", ClientRecordPage). Wings Company is the
 * fixed first row. Since the Funil (part 1), a client also carries its
 * expansion area and its tracked WhatsApp links, and the page keeps the rules
 * that map a landing page or a Meta form to a client.
 *
 * Registering, renaming and deactivating are `clients.manage`; Jurídico only
 * reads the list and fills the record.
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
          {update.error instanceof ApiError
            ? update.error.message
            : 'Não foi possível salvar a área.'}
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
        Cada link abre o WhatsApp da Wings com um código já escrito. Quem manda a mensagem é
        etiquetado com este cliente e o canal do link.
      </p>
      {links.data && !links.data.phoneConfigured && (
        <Alert kind="warning">
          O número de WhatsApp da Wings (WINGS_WHATSAPP_NUMBER) não está configurado neste ambiente.
        </Alert>
      )}
      <form
        className="clients-rename"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({ clientId: client.id, channel });
        }}
      >
        <Select
          aria-label={`Canal do novo link de ${client.name}`}
          value={channel}
          onChange={(event) => setChannel(event.target.value as LeadLinkChannel)}
        >
          {LEAD_LINK_CHANNELS.map((item) => (
            <option key={item} value={item}>
              {LEAD_CHANNEL_LABELS[item]}
            </option>
          ))}
        </Select>
        <Button
          type="submit"
          variant="ghost"
          disabled={create.isPending || links.data?.phoneConfigured === false}
        >
          Gerar link
        </Button>
      </form>
      {create.error && (
        <div className="field-error" role="alert">
          {create.error instanceof ApiError
            ? create.error.message
            : 'Não foi possível gerar o link.'}
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

function ClientRow({
  client,
  project,
  open,
  onToggle,
  onStatus,
  canManage,
}: {
  canManage: boolean;
  client: Client;
  project: ClientProject | undefined;
  open: boolean;
  onToggle: () => void;
  onStatus: (project: ClientProject) => void;
}) {
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
                <div className="cell-sub">
                  Expansão: {client.expansionArea.map(formatExpansionEntry).join(', ')}
                </div>
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
          {project && (
            <div className="clients-project">
              {project.canManage ? (
                <button
                  type="button"
                  className="projects-status-button"
                  aria-label={`Status do projeto de ${client.name}: ${PROJECT_STATUS_LABELS[project.status]}`}
                  onClick={() => onStatus(project)}
                >
                  <ProjectStatusTag status={project.status} />
                </button>
              ) : (
                <ProjectStatusTag status={project.status} />
              )}
              <div className="cell-sub">Etapa atual: {stageLabel(project.currentStage)}</div>
            </div>
          )}
        </td>
        <td>
          <div className="clients-actions">
            {!fixed && !editing && (
              <Link className="btn btn-ghost" to={`/formatacao/clientes/${client.id}`}>
                Ficha
              </Link>
            )}
            {canManage && !fixed && !editing && (
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
            {canManage && !fixed && client.active && (
              <Button type="button" variant="ghost" aria-expanded={open} onClick={onToggle}>
                {open ? 'Fechar' : 'Links e expansão'}
              </Button>
            )}
          </div>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="lead-client-details">
            <ExpansionArea client={client} />
            <TrackingLinks client={client} />
          </td>
        </tr>
      )}
    </>
  );
}

/** "Cadastro rápido": the name, and the CNPJ and main contact when already known. */
function QuickCreate() {
  const create = useCreateClient();
  const lookup = useCnpjLookup();
  const [name, setName] = useState('');
  const [cnpj, setCnpj] = useState('');
  const [contact, setContact] = useState({ name: '', email: '', whatsapp: '' });
  const cnpjDigits = cnpj.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const cnpjOk = cnpjDigits === '' || isValidCnpj(cnpjDigits);
  const reset = () => {
    create.reset();
  };

  return (
    <section className="block clients-quick">
      <h2>Novo cliente</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(
            {
              name,
              cnpj: cnpjDigits || null,
              contact: contact.name.trim()
                ? {
                    name: contact.name,
                    email: contact.email || null,
                    whatsapp: contact.whatsapp || null,
                  }
                : null,
            },
            {
              onSuccess: () => {
                setName('');
                setCnpj('');
                setContact({ name: '', email: '', whatsapp: '' });
                lookup.reset();
              },
            },
          );
        }}
      >
        <div className="grid-3">
          <Field
            label="CNPJ"
            hint={
              lookup.data
                ? `Receita: ${lookup.data.registrationStatus ?? 'situação não informada'}`
                : 'Opcional. Buscar preenche o nome.'
            }
            error={
              lookup.error
                ? lookup.error instanceof ApiError
                  ? lookup.error.message
                  : 'Não foi possível consultar o CNPJ.'
                : cnpjOk
                  ? undefined
                  : 'CNPJ inválido'
            }
          >
            <div className="input-row">
              <Input
                value={cnpjDigits.length === 14 ? formatCnpj(cnpjDigits) : cnpj}
                placeholder="00.000.000/0000-00"
                onChange={(event) => {
                  setCnpj(event.target.value);
                  lookup.reset();
                  reset();
                }}
              />
              <Button
                type="button"
                variant="ghost"
                disabled={cnpjDigits.length !== 14 || !cnpjOk || lookup.isPending}
                onClick={() =>
                  lookup.mutate(cnpjDigits, {
                    onSuccess: (found) => {
                      const suggested = found.company.tradeName ?? found.company.legalName;
                      if (suggested && !name.trim()) setName(suggested.slice(0, CLIENT_NAME_MAX));
                    },
                  })
                }
              >
                {lookup.isPending ? 'Buscando…' : 'Buscar'}
              </Button>
            </div>
          </Field>
          <Field label="Nome do cliente" required>
            <Input
              value={name}
              maxLength={CLIENT_NAME_MAX}
              placeholder="Como a Wings chama o cliente"
              onChange={(event) => {
                setName(event.target.value);
                reset();
              }}
            />
          </Field>
        </div>
        <div className="grid-3">
          <Field label="Contato principal">
            <Input
              value={contact.name}
              placeholder="Nome"
              onChange={(event) => setContact({ ...contact, name: event.target.value })}
            />
          </Field>
          <Field label="E-mail do contato">
            <Input
              type="email"
              value={contact.email}
              onChange={(event) => setContact({ ...contact, email: event.target.value })}
            />
          </Field>
          <Field label="WhatsApp do contato">
            <Input
              type="tel"
              value={contact.whatsapp}
              placeholder="(11) 99999-9999"
              onChange={(event) => setContact({ ...contact, whatsapp: event.target.value })}
            />
          </Field>
        </div>
        <Button
          type="submit"
          className="btn-inline"
          disabled={create.isPending || name.trim().length < 2 || !cnpjOk}
        >
          Cadastrar cliente
        </Button>
        <span className="field-hint clients-quick-hint">
          O resto dos dados vai na ficha do cliente.
        </span>
      </form>
      {create.error && (
        <Alert kind="error">
          {create.error instanceof ApiError
            ? create.error.message
            : 'Não foi possível cadastrar o cliente.'}
        </Alert>
      )}
    </section>
  );
}

export function ClientsPage() {
  const clients = useClients();
  const { data: user } = useSession();
  const canManage = hasPermission(user, 'clients.manage');
  // Every client's project, inactive ones included: this is the register of all of them.
  const projects = useProjects({ inactive: true });
  const [openId, setOpenId] = useState<string | null>(null);
  const [statusOf, setStatusOf] = useState<ClientProject | null>(null);
  const list = clients.data?.clients ?? [];
  const projectByClient = new Map(
    (projects.data?.projects ?? []).map((project) => [project.clientId, project]),
  );

  return (
    <>
      <header className="page-header">
        <h1>Clientes</h1>
        <p>
          Para quem o trabalho é feito. Cada cliente tem um número e uma pasta no Drive,
          Clientes/NN. Nome, criada no cadastro. A mídia gerada é arquivada pelo cliente escolhido;
          o nome do cliente não é enviado a fornecedores.
        </p>
      </header>

      {canManage && <QuickCreate />}
      {clients.isError && <Alert kind="error">Não foi possível carregar os clientes.</Alert>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th title="O número da pasta do cliente no Drive: Clientes/NN. Nome">Nº</th>
              <th>Nome</th>
              <th>Situação</th>
              <th title="Status e etapa atual do projeto; o quadro fica em Gestão → Projetos">
                Projeto
              </th>
              <th>
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {clients.isLoading && (
              <tr>
                <td colSpan={5} className="muted">
                  Carregando…
                </td>
              </tr>
            )}
            {list.map((client) => (
              <ClientRow
                key={client.id}
                client={client}
                project={projectByClient.get(client.id)}
                open={openId === client.id}
                onToggle={() => setOpenId((current) => (current === client.id ? null : client.id))}
                onStatus={setStatusOf}
                canManage={canManage}
              />
            ))}
          </tbody>
        </table>
      </div>

      {statusOf && <StatusDialog project={statusOf} onClose={() => setStatusOf(null)} />}
    </>
  );
}
